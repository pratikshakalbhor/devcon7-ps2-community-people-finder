/**
 * Optional embedding providers.
 *
 * The retrieval index ships with a deterministic lexical scorer as its default
 * (see `lib/build-index.ts` for why). Embeddings are opt-in: pass a provider and
 * the index blends a cosine-similarity signal into the same score.
 *
 * Two free-tier providers are wired up:
 *   - Google Gemini `text-embedding-004` via the REST API (free tier, key only)
 *   - Ollama `nomic-embed-text` / `mxbai-embed-large` on localhost (free, no key)
 *
 * Both are plain `fetch` calls — no SDK dependency.
 */

export interface EmbeddingProvider {
  /** Stable identifier, recorded on the index so scores are reproducible. */
  readonly id: string
  /** Vector length the provider returns. Used as a sanity check. */
  readonly dimensions: number
  /** Embed a batch of texts. Order is preserved; length must match input. */
  embed(texts: readonly string[]): Promise<number[][]>
}

/** Cosine similarity in [-1, 1]. Returns 0 for zero-norm vectors. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < length; i += 1) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    dot += x * y
    normA += x * x
    normB += y * y
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

/** Rescale a cosine in [-1, 1] to [0, 1] so it can be blended with BM25 scores. */
export function cosineToUnitInterval(similarity: number): number {
  return (Math.max(-1, Math.min(1, similarity)) + 1) / 2
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly provider: string,
    override readonly cause?: unknown,
  ) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

/**
 * Google Gemini text embeddings over REST.
 * Docs: https://ai.google.dev/gemini-api/docs/embeddings
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id: string
  /**
   * `text-embedding-004` returns 768 floats by default. A different model or a
   * truncated-output request can differ, so this is overridable — a mismatch
   * makes cosine similarity meaningless rather than throwing.
   */
  readonly dimensions: number
  readonly #apiKey: string
  readonly #model: string
  readonly #endpoint: string
  readonly #fetchImpl: typeof fetch

  constructor(options: {
    apiKey: string
    model?: string
    dimensions?: number
    endpoint?: string
    fetchImpl?: typeof fetch
  }) {
    this.#apiKey = options.apiKey
    this.#model = options.model ?? 'text-embedding-004'
    this.dimensions = options.dimensions ?? 768
    this.#endpoint =
      options.endpoint ??
      `https://generativelanguage.googleapis.com/v1beta/models/${this.#model}:batchEmbedContents`
    this.#fetchImpl = options.fetchImpl ?? fetch
    this.id = `gemini:${this.#model}`
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const response = await this.#fetchImpl(`${this.#endpoint}?key=${this.#apiKey}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: `models/${this.#model}`,
          content: { parts: [{ text }] },
          taskType: 'RETRIEVAL_DOCUMENT',
        })),
      }),
    })
    if (!response.ok) {
      throw new EmbeddingError(
        `Gemini embedding request failed: ${response.status} ${await safeText(response)}`,
        this.id,
      )
    }
    const payload = (await response.json()) as {
      embeddings?: { values?: number[] }[]
    }
    const vectors = payload.embeddings?.map((entry) => entry.values ?? []) ?? []
    if (vectors.length !== texts.length) {
      throw new EmbeddingError(
        `Gemini returned ${vectors.length} embeddings for ${texts.length} inputs`,
        this.id,
      )
    }
    return vectors
  }
}

/**
 * Ollama embeddings over its HTTP API.
 * Docs: https://github.com/ollama/ollama/blob/main/docs/api.md#embeddings
 */
export class OllamaEmbeddingProvider implements EmbeddingProvider {
  readonly id: string
  readonly dimensions: number
  readonly #baseUrl: string
  readonly #model: string
  readonly #fetchImpl: typeof fetch

  constructor(options: {
    baseUrl?: string
    model?: string
    dimensions?: number
    fetchImpl?: typeof fetch
  }) {
    this.#baseUrl = (options.baseUrl ?? 'http://127.0.0.1:11434').replace(/\/+$/, '')
    this.#model = options.model ?? 'nomic-embed-text'
    this.#fetchImpl = options.fetchImpl ?? fetch
    if (options.dimensions !== undefined) this.dimensions = options.dimensions
    else this.dimensions = this.#model.startsWith('mxbai') ? 1024 : 768
    this.id = `ollama:${this.#model}`
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return []
    const response = await this.#fetchImpl(`${this.#baseUrl}/api/embed`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.#model, input: [...texts] }),
    })
    if (!response.ok) {
      throw new EmbeddingError(
        `Ollama embedding request failed: ${response.status} ${await safeText(response)}`,
        this.id,
      )
    }
    const payload = (await response.json()) as { embeddings?: number[][] }
    const vectors = payload.embeddings ?? []
    if (vectors.length !== texts.length) {
      throw new EmbeddingError(
        `Ollama returned ${vectors.length} embeddings for ${texts.length} inputs`,
        this.id,
      )
    }
    return vectors
  }
}

/**
 * Deterministic provider used by the tests. Not a real embedding model — it hashes
 * tokens into buckets so identical inputs always give identical vectors. That is
 * enough to exercise the cosine code path without a network call.
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly id: string
  readonly dimensions: number

  constructor(dimensions = 64) {
    if (dimensions < 8) throw new Error('HashingEmbeddingProvider: dimensions must be >= 8')
    this.dimensions = dimensions
    this.id = `hashing:${dimensions}`
  }

  embed(texts: readonly string[]): Promise<number[][]> {
    // Deterministic, CPU-bound, no network: resolve rather than yield.
    return Promise.resolve(
      texts.map((text) => {
      const vector = new Array<number>(this.dimensions).fill(0)
      for (const token of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
        if (token === '') continue
        let hash = 0x811c9dc5
        for (let i = 0; i < token.length; i += 1) {
          hash ^= token.charCodeAt(i)
          hash = Math.imul(hash, 0x01000193) >>> 0
        }
        vector[hash % this.dimensions] =
          (vector[hash % this.dimensions] ?? 0) + 1
      }
      const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
      return norm === 0 ? vector : vector.map((value) => value / norm)
      }),
    )
  }
}

export interface EmbeddingEnv {
  readonly EMBEDDING_PROVIDER?: string
  readonly GEMINI_API_KEY?: string
  readonly GEMINI_EMBEDDING_MODEL?: string
  readonly OLLAMA_BASE_URL?: string
  readonly OLLAMA_EMBEDDING_MODEL?: string
}

/**
 * Build a provider from env, or return `null` when embeddings are not configured
 * (the default). Never throws on missing config — `undefined` means "lexical only".
 */
export function createEmbeddingProvider(
  env: EmbeddingEnv,
  options: { fetchImpl?: typeof fetch } = {},
): EmbeddingProvider | null {
  const choice = (env.EMBEDDING_PROVIDER ?? '').trim().toLowerCase()

  if (choice === 'gemini') {
    if (!env.GEMINI_API_KEY) {
      throw new Error('EMBEDDING_PROVIDER=gemini requires GEMINI_API_KEY')
    }
    return new GeminiEmbeddingProvider({
      apiKey: env.GEMINI_API_KEY,
      ...(env.GEMINI_EMBEDDING_MODEL ? { model: env.GEMINI_EMBEDDING_MODEL } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
  }

  if (choice === 'ollama') {
    return new OllamaEmbeddingProvider({
      ...(env.OLLAMA_BASE_URL ? { baseUrl: env.OLLAMA_BASE_URL } : {}),
      ...(env.OLLAMA_EMBEDDING_MODEL ? { model: env.OLLAMA_EMBEDDING_MODEL } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    })
  }

  if (choice === '' || choice === 'none' || choice === 'lexical') return null
  throw new Error(
    `Unknown EMBEDDING_PROVIDER "${choice}". Expected one of: gemini, ollama, none.`,
  )
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 300)
  } catch {
    return '<unreadable body>'
  }
}