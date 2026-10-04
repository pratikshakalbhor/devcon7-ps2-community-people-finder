/**
 * The grounded-answer entry point.
 *
 * Retrieval in, a verified answer out. The shape of the pipeline is the security
 * property:
 *
 *   1. `retrieveCandidates()` — code decides who is even eligible. Bounded to
 *      `TOP_K_CANDIDATES`, with weak matches dropped.
 *   2. Empty? -> **return the no-match response without calling the model at all.**
 *      Asking a model to pick from a list of nobody wastes a request and invites a
 *      model to be helpful by inventing someone.
 *   3. `buildGroundingMessages()` — system message is authored constants only.
 *   4. `askModel()` — the model may only *choose and explain*, never *discover*.
 *   5. `verifyCandidates()` — anything not on the list from step 1 is destroyed.
 *   6. Everything the model proposed was rejected? -> no-match response again.
 *
 * Both no-match triggers produce the same structured result via `noMatchResponse()`, so
 * callers never have to distinguish "nothing retrieved" from "the model tried to invent
 * someone" by inspecting an array length.
 */

import {
  buildGroundingMessages,
  buildCandidateBlock,
  buildSystemPrompt,
} from './build-grounding-prompt.js'
import { askModel, type AskModelOptions, type AskResult } from './llm-client.js'
import type { LlmConfig } from './llm-config.js'
import { LlmResponseError } from './llm-errors.js'
import {
  candidateNames,
  retrieveCandidates,
  type Candidate,
  type RetrievalDiagnostics,
  type RetrieveOptions,
} from './retrieve.js'
import type { CommunityIndex } from './build-index.js'
import {
  verifyCandidates,
  type RejectedMatch,
  type VerifyOptions,
} from './verify-candidates.js'

/** The message shown when nobody qualifies. Fixed text, never model-generated. */
export const NO_MATCH_MESSAGE = 'No one in the community currently matches that.'

/** Which branch produced a no-match result. */
export type NoMatchReason = 'nothing-above-threshold' | 'all-model-output-rejected'

export interface MatchResult {
  readonly ensName: string
  readonly reason: string
  readonly score: number
  readonly matchedSkills: readonly string[]
  readonly availability: string
  readonly injectionSuspected: boolean
  /** The candidate's own skills and bio, for rendering a card. Never model prose. */
  readonly skills: readonly string[]
  readonly bio: string
}

export interface AnswerResult {
  readonly query: string
  readonly matches: readonly MatchResult[]
  /** Always non-empty when `matches` is empty. */
  readonly message: string
  readonly noMatch: boolean
  readonly noMatchReason: NoMatchReason | null
  /** Diagnostics for logs and tests. Never contains profile text. */
  readonly retrieval: RetrievalDiagnostics
  /** Names actually sent to the model. Empty when no model call was made. */
  readonly candidateNames: readonly string[]
  /** Model output that the membership check refused, for auditing. */
  readonly rejected: readonly RejectedMatch[]
  /** Model metadata. `null` on the no-match paths that skip the model. */
  readonly model: { readonly model: string; readonly attempts: number } | null
}

/**
 * The single no-match response.
 *
 * `matches` is always empty, `message` is always the fixed string, and
 * `noMatchReason` says which gate fired.
 */
export function noMatchResponse(
  query: string,
  reason: NoMatchReason,
  details: {
    readonly retrieval: RetrievalDiagnostics
    readonly candidateNames: readonly string[]
    readonly rejected?: readonly RejectedMatch[]
  },
): AnswerResult {
  return {
    query,
    matches: [],
    message: NO_MATCH_MESSAGE,
    noMatch: true,
    noMatchReason: reason,
    retrieval: details.retrieval,
    candidateNames: details.candidateNames,
    rejected: details.rejected ?? [],
    model: null,
  }
}

export interface AnswerOptions extends RetrieveOptions, VerifyOptions {
  /** Endpoint config. Defaults to `loadLlmConfig()` inside `askModel`. */
  readonly config?: LlmConfig
  /**
   * Injectable model transport. Overrides the global `fetch`, which is what the tests
   * use to simulate hallucination, a hung endpoint, and a 429.
   */
  readonly fetchImpl?: typeof fetch
  /**
   * Injectable sleep for retry backoff. Records the delays instead of waiting, which is
   * how the tests assert that a `Retry-After` was capped without spending real time.
   */
  readonly sleep?: (ms: number) => Promise<void>
  /** Escape hatch for anything else `askModel` accepts, e.g. extra body fields. */
  readonly ask?: Omit<AskModelOptions, 'config' | 'fetchImpl' | 'sleep'>
}

/**
 * Answers a question about the community using only retrieved, verified profiles.
 *
 * @throws {BadQueryError} if the query is blank.
 * @throws {LlmError} subclasses when a model call is attempted and fails. Note that the
 * no-match paths never reach the model, so they cannot throw a transport error.
 */
export async function answerQuestion(
  index: CommunityIndex,
  query: string,
  options: AnswerOptions = {},
): Promise<AnswerResult> {
  const retrievalResult = await retrieveCandidates(index, query, options)
  const { candidates, diagnostics } = retrievalResult
  const names = candidateNames(candidates)

  // Gate 1: nothing worth showing the model. Stop here — no request is made.
  if (candidates.length === 0) {
    return noMatchResponse(retrievalResult.query, 'nothing-above-threshold', {
      retrieval: diagnostics,
      candidateNames: names,
    })
  }

  const askOptions: AskModelOptions = {
    ...options.ask,
    ...(options.config ? { config: options.config } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
  }

  const messages = buildGroundingMessages(retrievalResult.query, candidates)
  const completion: AskResult = await askModel(messages, askOptions)

  // Gate 2: whatever came back is checked against the *candidates we sent*, not against
  // the whole community. The model cannot widen its own scope.
  const verification = verifyCandidates(parseModelJson(completion.content), candidates, options)

  if (verification.matches.length === 0) {
    // Either the model returned nothing usable, or everything it returned was invented.
    // Both are a no-match, and the caller sees the same clean response either way.
    return noMatchResponse(retrievalResult.query, 'all-model-output-rejected', {
      retrieval: diagnostics,
      candidateNames: names,
      rejected: verification.rejected,
    })
  }

  return {
    query: retrievalResult.query,
    matches: verification.matches.map((match) => ({
      ensName: match.ensName,
      reason: match.reason,
      score: match.score,
      matchedSkills: match.matchedSkills,
      availability: match.availability,
      injectionSuspected: match.injectionSuspected,
      skills: match.skills,
      bio: match.bio,
    })),
    message: '',
    noMatch: false,
    noMatchReason: null,
    retrieval: diagnostics,
    candidateNames: names,
    rejected: verification.rejected,
    model: { model: completion.model, attempts: completion.attempts },
  }
}

/**
 * Parses the model's JSON reply, tolerating the usual wrappers.
 *
 * A model asked for JSON will sometimes wrap it in a fenced block or add a sentence of
 * prose. Recovering that is worth doing; anything still unparseable returns `null` so
 * `verifyCandidates` sees "nothing proposed" and the caller gets the no-match response.
 */
export function parseModelJson(content: string): unknown {
  const trimmed = content.trim()
  const candidates = [trimmed]

  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)
  if (fenced?.[1] !== undefined) candidates.unshift(fenced[1].trim())

  const braced = extractJsonSlice(trimmed)
  if (braced !== null) candidates.push(braced)

  for (const candidate of candidates) {
    if (candidate === '') continue
    try {
      return JSON.parse(candidate) as unknown
    } catch {
      // Try the next shape.
    }
  }
  return null
}

/**
 * Pulls the first balanced `{...}` or `[...]` run out of a longer string.
 *
 * Tracks string state so a brace or bracket *inside* a JSON string value does not
 * close the run early — `"reason": "use { and } freely"` is a perfectly ordinary
 * justification, and a naive depth counter truncates it mid-string into something that
 * fails to parse.
 */
function extractJsonSlice(text: string): string | null {
  const open = text.search(/[[{]/)
  if (open === -1) return null

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = open; index < text.length; index += 1) {
    const char = text[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (inString) {
      if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{' || char === '[') depth += 1
    else if (char === '}' || char === ']') {
      depth -= 1
      if (depth === 0) return text.slice(open, index + 1)
    }
  }
  return null
}

/**
 * Throws if a completion cannot be understood at all.
 *
 * Exported for callers that would rather fail loudly than degrade to no-match — e.g. a
 * batch job that treats an empty result as a bug. Not used by `answerQuestion`, which
 * prefers the no-match response.
 */
export function assertParsableCompletion(content: string): unknown {
  const parsed = parseModelJson(content)
  if (parsed === null) throw new LlmResponseError('reply was not parseable as JSON')
  return parsed
}

export { buildCandidateBlock, buildGroundingMessages, buildSystemPrompt }
export type { Candidate }
