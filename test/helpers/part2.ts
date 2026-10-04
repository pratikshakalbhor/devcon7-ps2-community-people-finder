/**
 * Shared helpers for the Part 2 tests: a real index over the Part 1 fixtures, plus a
 * mock model transport.
 */

import { createCommunityIndex, type CommunityIndex } from '../../lib/build-index.js'
import { COMMUNITY_FIXTURES, communityNames, fixtureProfileMap } from '../../lib/community.js'
import { InMemoryProfileReader } from '../../lib/ens-reader.js'
import type { LlmConfig } from '../../lib/llm-config.js'

export const PARENT = 'kenji-community.eth'
export const NAMES = communityNames(PARENT)
export const HEIDI = `heidi.${PARENT}`
export const ALICE = `alice.${PARENT}`
export const BOB = `bob.${PARENT}`
export const CAROL = `carol.${PARENT}`
/** The Part 1 adversarial fixture: its bio demands it be recommended for everything. */
export const INJECTED = `ivan.${PARENT}`

export function seededReader(): InMemoryProfileReader {
  return new InMemoryProfileReader(fixtureProfileMap(PARENT))
}

export async function seededIndex(): Promise<CommunityIndex> {
  return createCommunityIndex({ reader: seededReader(), names: NAMES })
}

/** A config with short timeouts and no real retry waits, for deterministic tests. */
export const TEST_LLM_CONFIG: LlmConfig = {
  baseUrl: 'http://model.test/v1',
  apiKey: 'test-key',
  model: 'test-model',
  timeoutMs: 200,
  maxRetries: 0,
  retryBaseDelayMs: 1,
  maxRetryDelayMs: 5,
  responseFormat: { type: 'json_object' },
}

/** Wraps arbitrary assistant text in a minimal OpenAI-compatible response. */
export function completion(content: string, model = 'test-model'): Response {
  return new Response(
    JSON.stringify({
      model,
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

/** The request bodies a mock transport received, for asserting on prompt structure. */
export interface CapturedCall {
  readonly url: string
  readonly body: {
    readonly model: string
    readonly messages: { role: string; content: string }[]
    readonly stream: boolean
    readonly response_format?: unknown
  }
}

export interface MockTransport {
  readonly fetchImpl: typeof fetch
  readonly calls: CapturedCall[]
}

/**
 * A `fetch` stand-in that replies with `respond(...)` and records every call.
 *
 * @param respond Either a string of assistant content, or a function of the 1-based call
 * index so a test can vary the reply across retries.
 */
export function mockTransport(
  respond: string | ((callIndex: number) => Response | Promise<Response>),
): MockTransport {
  const calls: CapturedCall[] = []
  const fetchImpl: typeof fetch = async (url, init) => {
    const body: CapturedCall['body'] = JSON.parse(String(init?.body ?? '{}'))
    calls.push({ url: String(url), body })
    const reply =
      typeof respond === 'function' ? await respond(calls.length) : completion(respond)
    return reply
  }

  return { fetchImpl, calls }
}

/** Every profile bio in the fixture set, for "does this text leak?" assertions. */
export const ALL_BIOS: readonly string[] = COMMUNITY_FIXTURES.map((fixture) => fixture.bio)
