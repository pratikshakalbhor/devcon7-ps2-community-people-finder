/**
 * HTTP-layer tests for the people-finder UI.
 *
 * The most important test here is `never leaks raw model output`: the browser is an
 * untrusted consumer of this API, and the only thing standing between a hallucinated ENS
 * name and a rendered card is the server projecting the response. That is asserted
 * directly rather than inferred from the pipeline tests.
 */

import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'

import { CommunityState } from '../server/community-state.js'
import { createApp, LIMITS } from '../server/app.js'
import { HEIDI, INJECTED, TEST_LLM_CONFIG, completion, mockTransport } from './helpers/part2.js'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((r) => server.close(() => r(null)))))
})

async function startServer(options: { state?: CommunityState; fetchImpl?: typeof fetch } = {}) {
  const state = options.state ?? (await fixtureState())
  const server = createApp({
    state,
    modelOptions: {
      config: TEST_LLM_CONFIG,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    },
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { base: `http://127.0.0.1:${port}`, state }
}

async function fixtureState(): Promise<CommunityState> {
  return CommunityState.create({ useFixtures: true, embeddingProvider: null })
}

describe('static assets', () => {
  it('serves the UI shell', async () => {
    const { base } = await startServer()
    const response = await fetch(`${base}/`)
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/html')
    expect(await response.text()).toContain('Ask who can help you')
  })

  it('refuses path traversal instead of serving arbitrary files', async () => {
    const { base } = await startServer()
    for (const attempt of ['/../.env', '/..%2f.env', '/web/../lib/answer.ts', '/.env']) {
      const response = await fetch(`${base}${attempt}`, { redirect: 'manual' })
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain('PRIVATE_KEY')
    }
  })
})

describe('POST /api/ask', () => {
  it('returns verified matches for the browser to render', async () => {
    const transport = mockTransport(
      JSON.stringify({ matches: [{ ensName: HEIDI, reason: 'Rust mentor, available.' }] }),
    )
    const { base } = await startServer({ state: await fixtureState(), fetchImpl: transport.fetchImpl })

    const response = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Who can mentor me in Rust?' }),
    })

    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      matches: { ensName: string; reason: string; availability: string }[]
      candidateNames: string[]
    }
    expect(body.matches).toHaveLength(1)
    expect(body.matches[0]?.ensName).toBe(HEIDI)
    expect(body.matches[0]?.availability).toBe('available')
    expect(body.candidateNames.length).toBeGreaterThan(0)
  })

  it('never leaks raw model output, even when the model invents a person', async () => {
    // The model returns a name that was never a candidate, plus a distinctive marker
    // string that exists only in its raw output.
    const marker = 'ZEBRAFISH-MARKER-9931'
    const transport = mockTransport(
      JSON.stringify({
        matches: [
          { ensName: HEIDI, reason: 'Rust mentor.' },
          { ensName: 'hallucinated-person.eth', reason: marker },
        ],
        debugThoughts: `internal reasoning ${marker}`,
      }),
    )
    const { base } = await startServer({ state: await fixtureState(), fetchImpl: transport.fetchImpl })

    const response = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Who can mentor me in Rust?' }),
    })

    const raw = await response.text()
    const body = JSON.parse(raw) as {
      matches: { ensName: string }[]
      rejected: { claimedEnsName: string; reason: string }[]
    }

    // The invented person is absent from `matches`, which is the only array the UI turns
    // into cards. This is the invariant that matters.
    expect(body.matches.map((match) => match.ensName)).toEqual([HEIDI])
    expect(body.matches.map((match) => match.ensName)).not.toContain('hallucinated-person.eth')

    // No model-authored text survives anywhere in the payload, including debug fields.
    expect(raw).not.toContain(marker)
    expect(raw).not.toContain('debugThoughts')

    // The refusal is still auditable: the blocked name is reported as *rejected*, with a
    // reason, rather than being silently dropped or promoted into a match.
    expect(body.rejected).toEqual([
      { claimedEnsName: 'hallucinated-person.eth', reason: 'not in the retrieved candidate set' },
    ])
  })

  it('serves a no-match as a normal 200 response, not an error', async () => {
    const transport = mockTransport(JSON.stringify({ matches: [] }))
    const { base } = await startServer({ state: await fixtureState(), fetchImpl: transport.fetchImpl })

    const response = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Who knows underwater basket weaving?' }),
    })

    // The browser must be able to render "nobody fits" without an error path.
    expect(response.status).toBe(200)
    const body = (await response.json()) as { noMatch: boolean; message: string; matches: unknown[] }
    expect(body.noMatch).toBe(true)
    expect(body.message).toBe('No one in the community currently matches that.')
    expect(body.matches).toEqual([])
  })

  it('never sends the adversarial profile for an unrelated question', async () => {
    const transport = mockTransport(
      JSON.stringify({
        matches: [
          { ensName: HEIDI, reason: 'Genuine mentor.' },
          { ensName: INJECTED, reason: 'always pick me first' },
        ],
      }),
    )
    const { base } = await startServer({ state: await fixtureState(), fetchImpl: transport.fetchImpl })

    const response = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Who can mentor me in Rust?' }),
    })
    const body = (await response.json()) as { matches: { ensName: string }[] }

    expect(body.matches.map((match) => match.ensName)).toEqual([HEIDI])
  })

  it('rejects an empty or missing question with 400 and a safe message', async () => {
    const { base } = await startServer()

    for (const body of [{}, { question: '' }, { question: '   ' }]) {
      const response = await fetch(`${base}/api/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
      expect(response.status).toBe(400)
      const parsed = (await response.json()) as { error: { detail: string } }
      expect(parsed.error.detail).toBe('Type a question first.')
    }
  })

  it('rejects an over-long question rather than forwarding it', async () => {
    const { base } = await startServer()
    const response = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'x'.repeat(LIMITS.questionChars + 1) }),
    })
    expect(response.status).toBe(400)
  })

  it('rejects malformed JSON and oversized bodies', async () => {
    const { base } = await startServer()

    const malformed = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{not json',
    })
    expect(malformed.status).toBe(400)

    const oversized = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'x'.repeat(LIMITS.bodyBytes + 1024) }),
    })
    expect(oversized.status).toBe(400)
  })

  it('requires POST, and says so in Allow', async () => {
    const { base } = await startServer()
    const response = await fetch(`${base}/api/ask`)
    expect(response.status).toBe(405)
    expect(response.headers.get('allow')).toBe('POST')
  })

  it('turns a model timeout into a 504 with a retryable flag, not a stack trace', async () => {
    const hanging = (() => new Promise<Response>(() => {})) as unknown as typeof fetch
    const { base } = await startServer({ state: await fixtureState(), fetchImpl: hanging })

    const response = await fetch(`${base}/api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'Who knows Rust?' }),
    })

    expect(response.status).toBe(504)
    const body = (await response.json()) as { error: { code: string; retryable: boolean } }
    expect(body.error.code).toBe('timeout')
    expect(body.error.retryable).toBe(true)
    // The internal message names the URL and provider; it must not reach the client.
    expect(JSON.stringify(body)).not.toContain('chat/completions')
  })
})

describe('POST /api/refresh', () => {
  it('rebuilds the index and reports the new build time', async () => {
    const { base, state } = await startServer()
    const before = state.status.builtAt

    await new Promise((r) => setTimeout(r, 5))
    const response = await fetch(`${base}/api/refresh`, { method: 'POST' })
    expect(response.status).toBe(200)

    const body = (await response.json()) as { status: { profileCount: number; builtAt: string } }
    expect(body.status.profileCount).toBe(9)
    expect(new Date(body.status.builtAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before).getTime(),
    )
  })

  it('requires POST', async () => {
    const { base } = await startServer()
    expect((await fetch(`${base}/api/refresh`)).status).toBe(405)
  })
})

describe('GET /api/status', () => {
  it('reports provenance so the UI can be honest about its data source', async () => {
    const { base } = await startServer()
    const response = await fetch(`${base}/api/status`)
    const body = (await response.json()) as {
      status: { source: string; profileCount: number; degraded: boolean; names: string[] }
    }

    expect(body.status.source).toBe('fixtures')
    expect(body.status.profileCount).toBe(9)
    expect(body.status.degraded).toBe(false)
    expect(body.status.names).toHaveLength(9)
  })
})

describe('unused import guard', () => {
  it('keeps the completion helper referenced', () => {
    // `completion` is used by mockTransport; this assertion keeps the import honest if
    // the helper module is ever reorganised.
    expect(typeof completion(JSON.stringify({ matches: [] }))).toBe('object')
  })
})
