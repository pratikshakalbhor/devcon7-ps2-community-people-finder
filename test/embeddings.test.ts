import { describe, expect, it } from 'vitest'
import {
  EmbeddingError,
  GeminiEmbeddingProvider,
  HashingEmbeddingProvider,
  OllamaEmbeddingProvider,
  cosineSimilarity,
  cosineToUnitInterval,
  createEmbeddingProvider,
} from '../lib/embeddings.js'

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? status : status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('cosineSimilarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1)
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0)
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1)
  })

  it('is scale invariant and safe for zero vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1)
    expect(cosineSimilarity([0, 0], [1, 2])).toBe(0)
  })

  it('rescales to [0, 1] for blending with BM25', () => {
    expect(cosineToUnitInterval(1)).toBe(1)
    expect(cosineToUnitInterval(-1)).toBe(0)
    expect(cosineToUnitInterval(0)).toBe(0.5)
  })
})

describe('HashingEmbeddingProvider', () => {
  it('is deterministic and shape-correct', async () => {
    const provider = new HashingEmbeddingProvider(32)
    const [a] = await provider.embed(['rust mentor'])
    const [b] = await provider.embed(['rust mentor'])
    expect(a).toHaveLength(32)
    expect(a).toEqual(b)
  })

  it('scores overlapping text above disjoint text', async () => {
    const provider = new HashingEmbeddingProvider(256)
    const [query, hit, miss] = await provider.embed([
      'rust mentor',
      'rust mentor available now',
      'solidity smart contract auditor',
    ])
    expect(cosineSimilarity(query as number[], hit as number[])).toBeGreaterThan(
      cosineSimilarity(query as number[], miss as number[]),
    )
  })

  it('rejects a degenerate dimension count', () => {
    expect(() => new HashingEmbeddingProvider(4)).toThrow(/dimensions/)
  })
})

describe('createEmbeddingProvider', () => {
  it('defaults to lexical-only', () => {
    expect(createEmbeddingProvider({})).toBeNull()
    expect(createEmbeddingProvider({ EMBEDDING_PROVIDER: 'none' })).toBeNull()
  })

  it('builds a Gemini provider from a key', () => {
    const provider = createEmbeddingProvider({
      EMBEDDING_PROVIDER: 'gemini',
      GEMINI_API_KEY: 'test-key',
    })
    expect(provider?.id).toBe('gemini:text-embedding-004')
  })

  it('builds an Ollama provider without a key and sizes the vector per model', () => {
    expect(createEmbeddingProvider({ EMBEDDING_PROVIDER: 'ollama' })?.id).toBe(
      'ollama:nomic-embed-text',
    )
    expect(
      createEmbeddingProvider({
        EMBEDDING_PROVIDER: 'ollama',
        OLLAMA_EMBEDDING_MODEL: 'mxbai-embed-large',
      }),
    ).toMatchObject({ id: 'ollama:mxbai-embed-large', dimensions: 1024 })
  })

  it('fails loudly on a misconfiguration', () => {
    expect(() => createEmbeddingProvider({ EMBEDDING_PROVIDER: 'gemini' })).toThrow(
      /GEMINI_API_KEY/,
    )
    expect(() => createEmbeddingProvider({ EMBEDDING_PROVIDER: 'cohere' })).toThrow(
      /Unknown EMBEDDING_PROVIDER/,
    )
  })
})

describe('provider HTTP shape', () => {
  it('Gemini posts batchEmbedContents and decodes the vectors', async () => {
    const calls: { url: string; body: unknown }[] = []
    const provider = new GeminiEmbeddingProvider({
      apiKey: 'k',
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body)) as unknown })
        return jsonResponse({ embeddings: [{ values: [0.1, 0.2] }, { values: [0.3, 0.4] }] })
      }) as unknown as typeof fetch,
    })

    const vectors = await provider.embed(['a', 'b'])
    expect(vectors).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ])
    expect(calls[0]?.url).toContain('batchEmbedContents')
    expect(calls[0]?.url).toContain('key=k')
    expect((calls[0]?.body as { requests: unknown[] }).requests).toHaveLength(2)
  })

  it('Ollama posts /api/embed and decodes the vectors', async () => {
    const seen: { url?: string; body?: unknown } = {}
    const provider = new OllamaEmbeddingProvider({
      baseUrl: 'http://localhost:11434/',
      model: 'nomic-embed-text',
      fetchImpl: (async (url: string, init: RequestInit) => {
        seen.url = String(url)
        seen.body = JSON.parse(String(init.body)) as unknown
        return jsonResponse({ embeddings: [[1, 0, 0]] })
      }) as unknown as typeof fetch,
    })

    expect(await provider.embed(['a'])).toEqual([[1, 0, 0]])
    expect(seen.url).toBe('http://localhost:11434/api/embed')
    expect((seen.body as { model: string }).model).toBe('nomic-embed-text')
  })

  it('raises a typed error on a non-OK response', async () => {
    const provider = new OllamaEmbeddingProvider({
      fetchImpl: (async () => jsonResponse({ error: 'model not found' }, false, 404)) satisfies typeof fetch,
    })
    await expect(provider.embed(['a'])).rejects.toBeInstanceOf(EmbeddingError)
  })

  it('raises when the provider returns the wrong number of vectors', async () => {
    const provider = new OllamaEmbeddingProvider({
      fetchImpl: (async () => jsonResponse({ embeddings: [[1, 0, 0]] })) satisfies typeof fetch,
    })
    await expect(provider.embed(['a', 'b'])).rejects.toThrow(/1 embeddings for 2 inputs/)
  })

  it('short-circuits on an empty batch without calling the network', async () => {
    let called = false
    const provider = new OllamaEmbeddingProvider({
      fetchImpl: (async () => {
        called = true
        return jsonResponse({ embeddings: [] })
      }) satisfies typeof fetch,
    })
    expect(await provider.embed([])).toEqual([])
    expect(called).toBe(false)
  })
})