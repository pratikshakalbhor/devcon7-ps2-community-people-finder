/**
 * The HTTP layer: three JSON endpoints plus the static UI.
 *
 * Dependencies are injected rather than imported directly, so the entire request path can
 * be exercised in tests with no network, no wallet and no model endpoint.
 *
 * The important invariant lives here: **`/api/ask` returns only what survived the Part 2
 * membership check.** The raw model reply is never serialised into the response, not even
 * for debugging — a leak that is easy to add later is exactly the kind that ships.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { answerQuestion, type AnswerResult } from '../lib/answer.js'
import type { CommunityIndex } from '../lib/build-index.js'
import { loadLlmConfig } from '../lib/llm-config.js'
import type { AskModelOptions } from '../lib/llm-client.js'
import { BadQueryError } from '../lib/normalize-ens-name.js'
import { httpStatusFor, presentError, type PresentedError } from '../lib/present-error.js'
import type { CommunityState, CommunityStatus } from './community-state.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = join(HERE, '..', 'web')

/** Caps on caller input, so one request cannot allocate or transmit without bound. */
export const LIMITS = {
  /** Generous for a natural-language question, short enough to keep one call cheap. */
  questionChars: 500,
  /** Request bodies are small JSON documents; anything larger is refused. */
  bodyBytes: 16 * 1024,
} as const

/**
 * A malformed request.
 *
 * Extends `BadQueryError` so `presentError` classifies it as a caller mistake (HTTP 400)
 * rather than an internal fault (502). These are the same kind of problem: the request is
 * wrong, not the server.
 */
export class BadRequestError extends BadQueryError {
  constructor(message: string) {
    super(message)
    this.name = 'BadRequestError'
  }
}

export interface AppDependencies {
  readonly state: CommunityState
  /** Injectable for tests; defaults to the real pipeline. */
  readonly ask?: typeof answerQuestion
  readonly modelOptions?: AskModelOptions
}

/**
 * Static assets come from a fixed allowlist rather than by joining the request path.
 *
 * Joining `req.url` onto a directory is the classic path-traversal bug; a map of exact
 * filenames cannot be escaped with `..` or an absolute path.
 */
const STATIC_ROUTES: ReadonlyMap<string, { readonly file: string; readonly type: string }> =
  new Map([
    ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
    ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
    ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ])

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // The API returns user-derived text: keep it out of shared caches and out of frames.
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  response.end(payload)
}

function sendPresentedError(
  response: ServerResponse,
  error: unknown,
  presented: PresentedError,
  context: string,
): void {
  // The technical message goes to the server log, never to the client: it can contain
  // endpoint URLs and provider detail that should not be echoed over HTTP.
  console.error(`[${context}] ${presented.code}:`, error instanceof Error ? error.message : error)
  sendJson(response, httpStatusFor(error), { error: presented })
}

/** Reads a bounded JSON body, refusing anything oversized rather than buffering it. */
async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    size += buffer.length
    if (size > LIMITS.bodyBytes) throw new BadRequestError('The request was too large.')
    chunks.push(buffer)
  }

  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new BadRequestError('The request body was not valid JSON.')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
    throw new BadRequestError('Expected a JSON object at the top level.')
  return parsed as Record<string, unknown>
}

function requireQuestion(body: Record<string, unknown>): string {
  const value = body.question
  if (typeof value !== 'string' || value.trim() === '')
    throw new BadRequestError('Type a question first.')
  if (value.length > LIMITS.questionChars)
    throw new BadRequestError(
      `That question is longer than the ${LIMITS.questionChars} character limit.`,
    )
  return value.trim()
}

function statusView(status: CommunityStatus) {
  return {
    source: status.source,
    parentName: status.parentName,
    profileCount: status.stats.documents,
    termCount: status.stats.terms,
    skipped: status.stats.skipped,
    embeddingProvider: status.embeddingProvider,
    builtAt: status.builtAt,
    degraded: status.degraded,
    warnings: status.warnings,
    names: status.names,
  }
}

/**
 * Projects an `AnswerResult` down to exactly what the browser is allowed to see.
 *
 * `rejected` is included deliberately: it is the audit trail proving the model's invented
 * names were dropped, and it contains only strings this server generated. The model's own
 * prose is not reachable from here.
 */
export function answerView(result: AnswerResult) {
  return {
    noMatch: result.noMatch,
    noMatchReason: result.noMatchReason,
    message: result.message,
    matches: result.matches.map((match) => ({
      ensName: match.ensName,
      reason: match.reason,
      availability: match.availability,
      matchedSkills: match.matchedSkills,
      score: match.score,
      injectionSuspected: match.injectionSuspected,
      skills: match.skills,
      bio: match.bio,
    })),
    rejected: result.rejected.map((entry) => ({
      claimedEnsName: entry.claimedEnsName,
      reason: entry.reason,
    })),
    candidateNames: result.candidateNames,
    retrieval: result.retrieval,
    model: result.model,
  }
}

export function createApp(deps: AppDependencies): Server {
  const ask = deps.ask ?? answerQuestion

  return createServer((request, response) => {
    void handle(request, response, deps, ask).catch((error: unknown) => {
      sendPresentedError(response, error, presentError(error), 'unhandled')
    })
  })
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  deps: AppDependencies,
  ask: typeof answerQuestion,
): Promise<void> {
  const method = request.method ?? 'GET'
  // `noUncheckedIndexedAccess` makes the split result optional even though the array always
  // has one element; fall back so the route lookup is always a string.
  const path = (request.url ?? '/').split('?')[0] ?? '/'

  if (path === '/api/ask' || path === '/api/refresh') {
    if (method !== 'POST') {
      response.setHeader('allow', 'POST')
      sendJson(response, 405, {
        error: {
          code: 'bad_request',
          title: 'That endpoint needs a POST request',
          detail: 'Send the form as a POST to this address.',
          retryable: false,
        },
      })
      return
    }

    const body = path === '/api/ask' ? await readJsonBody(request) : {}

    if (path === '/api/refresh') {
      const status = await deps.state.refresh()
      console.log('[refresh] UI requested a rebuild')
      sendJson(response, 200, { status: statusView(status) })
      return
    }

    const question = requireQuestion(body)
    const index: CommunityIndex = deps.state.index
    const result = await ask(index, question, {
      ...deps.modelOptions,
      config: deps.modelOptions?.config ?? loadLlmConfig(),
    })
    sendJson(response, 200, { question, ...answerView(result) })
    return
  }

  if (path === '/api/status' && (method === 'GET' || method === 'HEAD')) {
    sendJson(response, 200, { status: statusView(deps.state.status) })
    return
  }

  if (method === 'GET' || method === 'HEAD') {
    const asset = STATIC_ROUTES.get(path)
    if (asset === undefined) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('Not found')
      return
    }
    const contents = await readFile(join(WEB_ROOT, asset.file))
    response.writeHead(200, {
      'content-type': asset.type,
      'content-length': contents.length,
      'x-content-type-options': 'nosniff',
      // Static shell only; no secrets live in these files.
      'cache-control': 'no-cache',
    })
    response.end(method === 'HEAD' ? undefined : contents)
    return
  }

  response.setHeader('allow', 'GET, HEAD, POST')
  response.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' })
  response.end('Method not allowed')
}

export { BadQueryError }
