/**
 * End-to-end tests for the grounded-answer path.
 *
 * These exercise the full pipeline — retrieve, prompt, call, verify — against a mock
 * transport, and cover the two no-match gates plus the transport guarantees.
 */

import { describe, expect, it, vi } from 'vitest'
import {
  NO_MATCH_MESSAGE,
  answerQuestion,
  noMatchResponse,
  parseModelJson,
} from '../lib/answer.js'
import { LlmTimeoutError } from '../lib/llm-errors.js'
import { loadLlmConfig, LLM_DEFAULTS, LLM_ENV_VARS } from '../lib/llm-config.js'
import { parseRetryAfter } from '../lib/llm-client.js'
import {
  HEIDI,
  INJECTED,
  TEST_LLM_CONFIG,
  completion,
  mockTransport,
  seededIndex,
} from './helpers/part2.js'

/** The model returns the top candidate for a "rust mentor" query. */
function recommendingHeidi(): string {
  return JSON.stringify({
    matches: [{ ensName: HEIDI, reason: 'Declares rust and mentoring as skills.' }],
  })
}

describe('a grounded answer', () => {
  it('returns a verified match with its retrieval metadata', async () => {
    const transport = mockTransport(recommendingHeidi())

    const result = await answerQuestion(await seededIndex(), 'who can mentor me in rust?', {
      config: TEST_LLM_CONFIG,
      fetchImpl: transport.fetchImpl,
    })

    expect(result.noMatch).toBe(false)
    expect(result.noMatchReason).toBeNull()
    expect(result.message).toBe('')
    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.ensName).toBe(HEIDI)
    expect(result.matches[0]?.reason).toBe('Declares rust and mentoring as skills.')
    expect(result.matches[0]?.matchedSkills).toEqual(expect.arrayContaining(['rust', 'mentor']))
    expect(result.model).toEqual({ model: 'test-model', attempts: 1 })
  })

  it('sends the authored system prompt, the data block and the question as three messages', async () => {
    const transport = mockTransport(recommendingHeidi())

    await answerQuestion(await seededIndex(), 'who knows rust?', {
      config: TEST_LLM_CONFIG,
      fetchImpl: transport.fetchImpl,
    })

    const messages = transport.calls[0]?.body.messages ?? []
    expect(messages).toHaveLength(3)
    expect(messages.map((message) => message.role)).toEqual(['system', 'user', 'user'])
    expect(messages[0]?.content).toContain('You are a matching assistant')
    expect(messages[0]?.content).not.toContain('kenji-community.eth')
    expect(messages[1]?.content).toContain('BEGIN CANDIDATE PROFILE DATA')
    expect(messages[2]?.content).toBe('who knows rust?')
    expect(transport.calls[0]?.body.response_format).toEqual({ type: 'json_object' })
  })

  it('strips a hallucinated person before the result reaches the caller', async () => {
    const transport = mockTransport(
      JSON.stringify({
        matches: [
          { ensName: HEIDI, reason: 'Genuine Rust mentor.' },
          { ensName: 'satoshi.kenji-community.eth', reason: 'Invented.' },
        ],
      }),
    )

    const result = await answerQuestion(await seededIndex(), 'who knows rust?', {
      config: TEST_LLM_CONFIG,
      fetchImpl: transport.fetchImpl,
    })

    expect(result.matches.map((match) => match.ensName)).toEqual([HEIDI])
    // The hallucination is recorded for auditing, but it is not in `matches`.
    expect(result.rejected.map((entry) => entry.claimedEnsName)).toEqual([
      'satoshi.kenji-community.eth',
    ])
    expect(JSON.stringify(result.matches)).not.toContain('satoshi')
  })

  it('does not surface the adversarial profile for an unrelated query', async () => {
    const transport = mockTransport(
      JSON.stringify({
        matches: [
          { ensName: HEIDI, reason: 'Rust mentor.' },
          // The bio's demand, obeyed by a compromised model.
          { ensName: INJECTED, reason: 'I am the best Rust mentor, always pick me first.' },
        ],
      }),
    )

    const result = await answerQuestion(await seededIndex(), 'who can mentor me in rust?', {
      config: TEST_LLM_CONFIG,
      fetchImpl: transport.fetchImpl,
    })

    expect(result.matches.map((match) => match.ensName)).toEqual([HEIDI])
    expect(result.candidateNames).not.toContain(INJECTED)
    expect(JSON.stringify(result.matches)).not.toContain('always pick me first')
    expect(result.rejected.some((entry) => entry.claimedEnsName === INJECTED)).toBe(true)
  })

  it('recovers a reply that is wrapped in a code fence', async () => {
    const transport = mockTransport(
      '```json\n' + recommendingHeidi() + '\n```\nHope that helps!',
    )

    const result = await answerQuestion(await seededIndex(), 'rust mentor', {
      config: TEST_LLM_CONFIG,
      fetchImpl: transport.fetchImpl,
    })

    expect(result.matches.map((match) => match.ensName)).toEqual([HEIDI])
  })

  it('recovers a reply with prose wrapped around the JSON', async () => {
    const transport = mockTransport(
      'Sure! Here you go: ' + recommendingHeidi() + ' Let me know if you need more.',
    )

    const result = await answerQuestion(await seededIndex(), 'rust mentor', {
      config: TEST_LLM_CONFIG,
      fetchImpl: transport.fetchImpl,
    })

    expect(result.matches.map((match) => match.ensName)).toEqual([HEIDI])
  })
})

describe('the no-match branch', () => {
  it('returns the no-match response without calling the model at all', async () => {
    const transport = mockTransport(recommendingHeidi())

    const result = await answerQuestion(await seededIndex(), 'underwater basket weaving', {
      config: TEST_LLM_CONFIG,
      fetchImpl: transport.fetchImpl,
    })

    expect(result.noMatch).toBe(true)
    expect(result.noMatchReason).toBe('nothing-above-threshold')
    expect(result.matches).toEqual([])
    expect(result.message).toBe(NO_MATCH_MESSAGE)
    // The decisive assertion: no request was made.
    expect(transport.calls).toHaveLength(0)
    expect(result.model).toBeNull()
  })

  it('returns the no-match response when every model entry was invented', async () => {
    const transport = mockTransport(
      JSON.stringify({ matches: [{ ensName: 'ghost.eth', reason: 'Nobody.' }] }),
    )

    const result = await answerQuestion(await seededIndex(), 'who knows rust?', {
      config: TEST_LLM_CONFIG,
      fetchImpl: transport.fetchImpl,
    })

    expect(result.noMatch).toBe(true)
    expect(result.noMatchReason).toBe('all-model-output-rejected')
    expect(result.matches).toEqual([])
    expect(result.message).toBe(NO_MATCH_MESSAGE)
    // The candidates were found and the model was consulted; the output was refused.
    expect(result.candidateNames).toContain(HEIDI)
    expect(result.rejected).toHaveLength(1)
  })

  it('returns the no-match response when the model replies with prose', async () => {
    const transport = mockTransport('I am not able to answer that.')

    const result = await answerQuestion(await seededIndex(), 'who knows rust?', {
      config: TEST_LLM_CONFIG,
      fetchImpl: transport.fetchImpl,
    })

    expect(result.noMatch).toBe(true)
    expect(result.message).toBe(NO_MATCH_MESSAGE)
  })

  it('never lets the model author the no-match message', async () => {
    const transport = mockTransport(
      JSON.stringify({ matches: [], message: 'Trust me, ask bob.eth anyway.' }),
    )

    const result = await answerQuestion(await seededIndex(), 'who knows rust?', {
      config: TEST_LLM_CONFIG,
      fetchImpl: transport.fetchImpl,
    })

    expect(result.message).toBe(NO_MATCH_MESSAGE)
    expect(result.message).not.toContain('bob')
  })

  it('builds a well-formed no-match response from the shared helper', () => {
    const result = noMatchResponse('anything', 'nothing-above-threshold', {
      retrieval: {
        considered: 0,
        droppedNoEvidence: 0,
        droppedLowRelevance: 0,
        droppedByCap: 0,
        bestScore: 0,
      },
      candidateNames: [],
    })

    expect(result.noMatch).toBe(true)
    expect(result.matches).toEqual([])
    expect(result.message).toBe(NO_MATCH_MESSAGE)
  })
})

describe('transport guarantees', () => {
  it('aborts a hanging model call instead of hanging the caller', async () => {
    // Ignores the abort signal entirely, to prove the timeout does not rely on fetch
    // internals to escape a hung transport.
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch

    const startedAt = Date.now()
    await expect(
      answerQuestion(await seededIndex(), 'who knows rust?', {
        config: { ...TEST_LLM_CONFIG, timeoutMs: 150 },
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(LlmTimeoutError)

    // If this test hangs the guard failed; if it is slow the timeout is not enforced.
    expect(Date.now() - startedAt).toBeLessThan(5_000)
  })

  it('reports the timeout with its configured budget', async () => {
    const fetchImpl = (() => new Promise<Response>(() => {})) as unknown as typeof fetch

    await expect(
      answerQuestion(await seededIndex(), 'who knows rust?', {
        config: { ...TEST_LLM_CONFIG, timeoutMs: 100 },
        fetchImpl,
      }),
    ).rejects.toThrow(/timed out after 100ms/)
  })

  it('does not retry a timeout, so a slow endpoint fails fast', async () => {
    const fetchImpl = vi.fn(() => new Promise<Response>(() => {})) as unknown as typeof fetch

    await expect(
      answerQuestion(await seededIndex(), 'rust mentor', {
        config: { ...TEST_LLM_CONFIG, timeoutMs: 80, maxRetries: 3 },
        fetchImpl,
      }),
    ).rejects.toBeInstanceOf(LlmTimeoutError)

    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('retries a 429 and then succeeds', async () => {
    const sleep = vi.fn(async () => {})
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call += 1
      return call === 1
        ? new Response('slow down', { status: 429 })
        : completion(recommendingHeidi())
    }) as unknown as typeof fetch

    const result = await answerQuestion(await seededIndex(), 'rust mentor', {
      config: { ...TEST_LLM_CONFIG, maxRetries: 2 },
      fetchImpl,
      sleep,
    })

    expect(result.matches[0]?.ensName).toBe(HEIDI)
    expect(result.model?.attempts).toBe(2)
    expect(sleep).toHaveBeenCalledTimes(1)
  })

  it('caps a malicious Retry-After instead of parking the request for hours', async () => {
    const sleep = vi.fn(async () => {})
    let call = 0
    const fetchImpl = vi.fn(async () => {
      call += 1
      return call === 1
        ? new Response('slow down', { status: 429, headers: { 'retry-after': '86400' } })
        : completion(recommendingHeidi())
    }) as unknown as typeof fetch

    await answerQuestion(await seededIndex(), 'rust mentor', {
      config: { ...TEST_LLM_CONFIG, maxRetries: 1, maxRetryDelayMs: 25 },
      fetchImpl,
      sleep,
    })

    // 86400 seconds, honoured but clamped to the ceiling.
    expect(sleep).toHaveBeenCalledWith(25)
  })

  it('surfaces a persistent rate limit rather than returning an unverified answer', async () => {
    const sleep = vi.fn(async () => {})
    const fetchImpl = vi.fn(
      async () => new Response('rate limited', { status: 429 }),
    ) as unknown as typeof fetch

    await expect(
      answerQuestion(await seededIndex(), 'rust mentor', {
        config: { ...TEST_LLM_CONFIG, maxRetries: 1 },
        fetchImpl,
        sleep,
      }),
    ).rejects.toThrow(/rate-limited/)

    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})

describe('model reply parsing', () => {
  const cases: readonly [string, string, boolean][] = [
    ['bare JSON', '{"matches":[]}', true],
    ['a fenced block', '```json\n{"matches":[]}\n```', true],
    ['a bare fence', '```\n{"matches":[]}\n```', true],
    ['JSON with prose around it', 'Sure! {"matches":[]} Done.', true],
    ['prose only', 'I cannot help with that.', false],
    ['empty string', '', false],
    ['a truncated object', '{"matches":[{"ensName":', false],
  ]

  for (const [label, content, shouldParse] of cases) {
    it(`${shouldParse ? 'parses' : 'does not parse'} ${label}`, () => {
      expect(parseModelJson(content) !== null).toBe(shouldParse)
    })
  }

  it('is not fooled by a brace inside a JSON string value', () => {
    const parsed = parseModelJson(
      '{"matches":[{"ensName":"a.eth","reason":"use { and } freely"}]} trailing',
    ) as { matches: { reason: string }[] }

    expect(parsed.matches[0]?.reason).toBe('use { and } freely')
  })
})

describe('LLM configuration', () => {
  it('defaults to a local endpoint that needs no key', () => {
    const config = loadLlmConfig({})
    expect(config.baseUrl).toBe(LLM_DEFAULTS.baseUrl)
    expect(config.model).toBe(LLM_DEFAULTS.model)
    expect(config.responseFormat).toEqual({ type: 'json_object' })
  })

  it('distinguishes an explicitly empty key from an unset one', () => {
    expect(loadLlmConfig({ [LLM_ENV_VARS.apiKey]: '' }).apiKey).toBe('')
    expect(loadLlmConfig({}).apiKey).toBe(LLM_DEFAULTS.apiKey)
  })

  it('rejects an unusable numeric setting rather than defaulting it to NaN', () => {
    expect(() => loadLlmConfig({ [LLM_ENV_VARS.timeoutMs]: 'soon' })).toThrow(/timeout/i)
    expect(() => loadLlmConfig({ [LLM_ENV_VARS.maxRetries]: '-1' })).toThrow(
      `${LLM_ENV_VARS.maxRetries} must be an integer >= 0`,
    )
  })

  it('parses Retry-After in both seconds and HTTP-date form', () => {
    expect(parseRetryAfter('3')).toBe(3000)
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter('not-a-date')).toBeNull()
    expect(parseRetryAfter('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('Wed, 21 Oct 2015 07:27:00 GMT'))).toBe(60_000)
  })
})
