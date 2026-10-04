/**
 * The retrieval index.
 *
 * Data source: live ENS text records. `CommunityIndex.create()` takes a
 * `ProfileReader` + a roster of names, reads every profile, and builds an
 * inverted lexical index with a BM25-style scorer. `refresh()` re-reads the same
 * names and rebuilds from scratch, so editing anyone's bio and calling
 * `refresh()` changes the very next query's results.
 *
 * ---------------------------------------------------------------------------
 * Why lexical scoring is the default
 * ---------------------------------------------------------------------------
 * The first pass uses IDF-weighted term overlap (BM25) over a *weighted* pseudo
 * document where declared skills count several times more than prose. Reasons:
 *   1. Deterministic — the same index + query always gives the same ranking,
 *      which is what makes the ranking tests meaningful assertions rather than
 *      "usually passes".
 *   2. Free and offline — no API key, no network, no rate limit, no cold start.
 *      Judges can run `npm test` with no setup.
 *   3. Skills are short, declared, and bounded. For "who knows Rust" an inverted
 *      index on `community.dev.skills` is close to optimal; dense retrieval earns
 *      its keep on long unstructured prose, which we do not have.
 *   4. Nothing about lexical matching lets text in a bio *instruct* anything. It
 *      only changes a number.
 *
 * Dense retrieval is still wired up and blends in via `embeddingProvider`
 * (Gemini or Ollama — see `lib/embeddings.ts`) for when the corpus grows or the
 * queries get fuzzy ("who can help me stop leaking memory"). `EMBEDDING_PROVIDER`
 * in `.env` turns it on; it is off by default.
 */
import {
  AVAILABILITY_MULTIPLIER,
  PROFILE_RECORD_KEYS,
  isProfileUsable,
  type Availability,
  type CommunityProfile,
  type ProfileAvailability,
} from './profile-schema.js'
import { readCommunityProfiles, type ProfileReader, type ReadProfilesOptions } from './ens-reader.js'
import { bigrams, expandQueryTerms, tokenize } from './tokenize.js'
import {
  cosineSimilarity,
  cosineToUnitInterval,
  type EmbeddingProvider,
} from './embeddings.js'

/** BM25 term-frequency saturation. Higher = repeated terms count more. */
const K1 = 1.2
/** BM25 length normalisation. 0 = no length penalty, 1 = full. */
const B = 0.75

/** A declared skill is a far stronger signal than the same word in prose. */
export const FIELD_WEIGHTS = {
  skills: 4,
  bio: 1,
  name: 2,
  availability: 0,
} as const

/** Added when a query term exactly matches a declared skill slug. */
export const SKILL_MATCH_BONUS = 3
/** Added per query bigram found verbatim in the profile text ("rust mentor"). */
export const PHRASE_MATCH_BONUS = 2
/** Multiplier applied when the bio tripped the injection heuristics. */
export const INJECTION_PENALTY = 0.25

export interface IndexScoringOptions {
  /** Blend weight for dense cosine similarity, 0 (lexical only) .. 1. */
  readonly embeddingWeight?: number
  /**
   * Demote profiles whose bio contains LLM-directed instructions. Defaults to
   * `true`; see `INJECTION_PATTERNS` in lib/profile-schema.ts.
   */
  readonly penaliseSuspectedInjection?: boolean
  /** Multiplier for flagged profiles. */
  readonly injectionPenalty?: number
  readonly fieldWeights?: Partial<typeof FIELD_WEIGHTS>
}

export interface CommunityIndexOptions extends IndexScoringOptions {
  /** Source of truth for profile data. In tests this is `InMemoryProfileReader`. */
  readonly reader: ProfileReader
  /**
   * The community roster: the ENS names (2LDs or NameWrapper subnames) to index.
   * Names, not data — every field is read from chain.
   */
  readonly names: readonly string[]
  readonly readOptions?: ReadProfilesOptions
  /** Optional dense retriever. `null`/omitted = lexical only. */
  readonly embeddingProvider?: EmbeddingProvider | null
  /** Skip profiles with no bio and no skills. Defaults to `true`. */
  readonly requireUsableProfiles?: boolean
  /** Diagnostics sink. */
  readonly onWarning?: (message: string) => void
}

export interface QueryOptions {
  /** Max results. Default 5. */
  readonly limit?: number
  /** Drop results scoring at or below this. Default 0 (i.e. any match). */
  readonly minScore?: number
  /** Restrict to these availability tiers. */
  readonly availability?: readonly ProfileAvailability[]
  /** Free-form post-filter. */
  readonly filter?: (profile: CommunityProfile) => boolean
}

export interface QueryResult {
  readonly name: string
  /** Final blended score, higher is better. */
  readonly score: number
  /** Raw BM25 sum before bonuses, multipliers and embedding blending. */
  readonly lexicalScore: number
  /** Cosine similarity mapped to [0, 1], or `null` when embeddings are off. */
  readonly embeddingScore: number | null
  /** Query terms that hit this profile. */
  readonly matchedTerms: readonly string[]
  /** Declared skill slugs that exactly matched a query term. */
  readonly matchedSkills: readonly string[]
  readonly availability: ProfileAvailability
  /** True when the bio tripped the injection heuristics. */
  readonly injectionSuspected: boolean
  readonly profile: CommunityProfile
}

interface IndexedDocument {
  readonly name: string
  readonly profile: CommunityProfile
  /** term -> weighted term frequency */
  readonly termFreq: Map<string, number>
  readonly weightedLength: number
  /** Literal skill slugs, for exact-match bonuses. */
  readonly skillSlugs: ReadonlySet<string>
  /** Normalised skill atoms, for atom-level bonuses. */
  readonly skillAtomSet: ReadonlySet<string>
  /** Lowercased bio + skills text, for phrase matching. */
  readonly phraseText: string
  readonly vector: readonly number[] | null
}

export interface IndexStats {
  readonly documents: number
  readonly terms: number
  readonly embeddingProvider: string | null
  readonly embeddingWeight: number
  readonly skipped: number
  readonly warnings: readonly string[]
}

/**
 * An immutable snapshot of the community, plus the ability to replace itself.
 *
 * `refresh()` mutates in place and returns `this`, so a long-lived server can
 * hold one instance and call `await index.refresh()` after someone edits a bio.
 */
export class CommunityIndex {
  #documents: IndexedDocument[] = []
  #idf = new Map<string, number>()
  #averageLength = 0
  #builtAt = 0
  #stats: IndexStats = {
    documents: 0,
    terms: 0,
    embeddingProvider: null,
    embeddingWeight: 0,
    skipped: 0,
    warnings: [],
  }

  readonly #reader: ProfileReader
  readonly #names: readonly string[]
  readonly #readOptions: ReadProfilesOptions | undefined
  readonly #embeddingProvider: EmbeddingProvider | null
  readonly #embeddingWeight: number
  readonly #fieldWeights: typeof FIELD_WEIGHTS
  readonly #penaliseInjection: boolean
  readonly #injectionPenalty: number
  readonly #requireUsable: boolean
  readonly #onWarning: ((message: string) => void) | undefined

  private constructor(options: CommunityIndexOptions) {
    this.#reader = options.reader
    this.#names = [...options.names]
    this.#readOptions = options.readOptions
    this.#embeddingProvider = options.embeddingProvider ?? null
    this.#embeddingWeight = clamp01(options.embeddingWeight ?? (this.#embeddingProvider ? 0.4 : 0))
    this.#fieldWeights = { ...FIELD_WEIGHTS, ...options.fieldWeights }
    this.#penaliseInjection = options.penaliseSuspectedInjection ?? true
    this.#injectionPenalty = options.injectionPenalty ?? INJECTION_PENALTY
    this.#requireUsable = options.requireUsableProfiles ?? true
    this.#onWarning = options.onWarning
  }

  /** Read every rostered profile from the reader and build the index. */
  static async create(options: CommunityIndexOptions): Promise<CommunityIndex> {
    const index = new CommunityIndex(options)
    await index.#rebuild()
    return index
  }

  /**
   * Build an index from already-parsed profiles, with no reader behind it.
   *
   * `refresh()` is unavailable on such an index — use `refreshWithProfiles()`.
   * The production path is `create()`, which reads from chain.
   */
  static async fromProfiles(
    profiles: readonly CommunityProfile[],
    options: Omit<CommunityIndexOptions, 'reader' | 'names'> = {},
  ): Promise<CommunityIndex> {
    const index = new CommunityIndex({
      reader: new NeverReader(),
      names: profiles.map((profile) => profile.name),
      ...options,
    })
    await index.#compile(profiles)
    return index
  }

  get size(): number {
    return this.#documents.length
  }

  /** Epoch millis of the last successful build. */
  get builtAt(): number {
    return this.#builtAt
  }

  get stats(): IndexStats {
    return this.#stats
  }

  /** Every indexed profile, in roster order. */
  all(): CommunityProfile[] {
    return this.#documents.map((doc) => doc.profile)
  }

  get(name: string): CommunityProfile | undefined {
    const needle = name.trim().toLowerCase()
    return this.#documents.find((doc) => doc.name.toLowerCase() === needle)?.profile
  }

  /**
   * Re-read every rostered profile from the reader and rebuild the index.
   * Idempotent; safe to call as often as you like.
   */
  async refresh(): Promise<this> {
    await this.#rebuild()
    return this
  }

  /** Same as `refresh()` but for indexes built via `fromProfiles`. */
  async refreshWithProfiles(profiles: readonly CommunityProfile[]): Promise<this> {
    await this.#compile(profiles)
    return this
  }

  /**
   * Rank the community against a free-text query.
   *
   * Scoring, in order:
   *   1. IDF-weighted BM25 over the weighted pseudo-document.
   *   2. `+SKILL_MATCH_BONUS` per query term that exactly matches a declared skill.
   *   3. `+PHRASE_MATCH_BONUS` per query bigram found verbatim in bio/skills.
   *   4. `x` availability multiplier.
   *   5. `x` injection penalty when the bio contains LLM-directed instructions.
   *   6. Optional blend with dense cosine similarity.
   *
   * Async because embedding the query is a network call. With the default
   * lexical-only configuration it resolves immediately without any I/O.
   */
  async query(queryText: string, options: QueryOptions = {}): Promise<QueryResult[]> {
    const limit = options.limit ?? 5
    const minScore = options.minScore ?? 0
    const terms = expandQueryTerms(queryText)
    const phraseNeedles = bigrams(tokenize(queryText))
    if (terms.length === 0) return []

    const useEmbeddings = this.#embeddingProvider !== null && this.#embeddingWeight > 0
    const queryVector = useEmbeddings
      ? await prepareQueryVector(this.#embeddingProvider, queryText)
      : null

    const scored = this.#documents
      .filter((doc) =>
        options.availability ? options.availability.includes(doc.profile.availability) : true,
      )
      .filter((doc) => (options.filter ? options.filter(doc.profile) : true))
      .map((doc) => this.#scoreDocument(doc, terms, phraseNeedles, queryText, queryVector))
      .filter((result) => result.lexicalScore > 0 || result.embeddingScore !== null)

    if (scored.length === 0) return []

    const maxLexical = scored.reduce((max, result) => Math.max(max, result.lexicalScore), 0)

    const results: QueryResult[] = scored.map((result) => {
      const lexicalUnit = maxLexical > 0 ? result.lexicalScore / maxLexical : 0
      const embeddingUnit = result.embeddingScore ?? 0
      const score = useEmbeddings
        ? (1 - this.#embeddingWeight) * lexicalUnit + this.#embeddingWeight * embeddingUnit
        : result.lexicalScore

      return {
        ...result,
        score,
        embeddingScore: useEmbeddings ? result.embeddingScore : null,
      }
    })

    results.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))

    return results.filter((result) => result.score > minScore).slice(0, Math.max(0, limit))
  }

  /** Serializable snapshot, handy for caching or handing to a UI. */
  toJSON(): {
    builtAt: number
    stats: IndexStats
    profiles: CommunityProfile[]
  } {
    return { builtAt: this.#builtAt, stats: this.#stats, profiles: this.all() }
  }

  // -------------------------------------------------------------------------

  async #rebuild(): Promise<void> {
    const profiles = await readCommunityProfiles(this.#reader, this.#names, this.#readOptions)
    await this.#compile(profiles)
  }

  async #compile(profiles: readonly CommunityProfile[]): Promise<void> {
    const warnings: string[] = []
    const kept: CommunityProfile[] = []
    let skipped = 0

    for (const profile of profiles) {
      if (this.#requireUsable && !isProfileUsable(profile)) {
        skipped += 1
        warnings.push(
          `skipped "${profile.name}": ${profile.issues.map((issue) => issue.message).join('; ') || 'no bio or skills'}`,
        )
        continue
      }
      for (const issue of profile.issues) {
        warnings.push(`${profile.name}: ${issue.field} — ${issue.message}`)
      }
      if (profile.flags.injectionSuspected) {
        warnings.push(
          `${profile.name}: bio contains LLM-directed instructions (${profile.flags.injectionPatterns.join(', ')})`,
        )
      }
      kept.push(profile)
    }

    const vectors = await this.#embedAll(kept)
    const documents = kept.map((profile, i) => this.#buildDocument(profile, vectors[i] ?? null))

    this.#idf = computeIdf(documents)
    this.#averageLength =
      documents.length === 0
        ? 0
        : documents.reduce((sum, doc) => sum + doc.weightedLength, 0) / documents.length
    this.#documents = documents
    this.#builtAt = Date.now()
    this.#stats = {
      documents: documents.length,
      terms: this.#idf.size,
      embeddingProvider: this.#embeddingProvider?.id ?? null,
      embeddingWeight: this.#embeddingWeight,
      skipped,
      warnings,
    }

    for (const warning of warnings) this.#onWarning?.(warning)
  }

  async #embedAll(profiles: readonly CommunityProfile[]): Promise<(number[] | null)[]> {
    if (!this.#embeddingProvider || this.#embeddingWeight <= 0) {
      return profiles.map(() => null)
    }
    const vectors = await this.#embeddingProvider.embed(profiles.map(embeddingDocument))
    if (vectors.length !== profiles.length) {
      throw new Error(
        `Embedding provider ${this.#embeddingProvider.id} returned ${vectors.length} vectors for ${profiles.length} profiles`,
      )
    }
    return vectors
  }

  #buildDocument(profile: CommunityProfile, vector: number[] | null): IndexedDocument {
    const weights = this.#fieldWeights
    const termFreq = new Map<string, number>()
    let weightedLength = 0

    const addField = (fieldTokens: readonly string[], weight: number): void => {
      if (weight <= 0) return
      for (const token of fieldTokens) {
        termFreq.set(token, (termFreq.get(token) ?? 0) + weight)
        weightedLength += weight
      }
    }

    addField(tokenize(profile.name.replace(/\./g, ' ')), weights.name)

    // Skills are indexed twice: as normalised terms (`mentoring` -> `mentor`,
    // `rust-async` -> `rust`, `async`) and as the raw slug so a compound skill is
    // reachable as one term as well as through its atoms.
    const skillTerms = unique(profile.skills.flatMap((slug) => tokenize(slug)))
    const atomTerms = unique(profile.skillAtoms.flatMap((atom) => tokenize(atom)))
    addField([...skillTerms, ...atomTerms], weights.skills)

    addField(tokenize(profile.bio), weights.bio)

    return {
      name: profile.name,
      profile,
      termFreq,
      weightedLength,
      skillSlugs: new Set(skillTerms),
      skillAtomSet: new Set(atomTerms),
      phraseText: `${profile.bio} ${profile.skills.join(' ')}`.toLowerCase(),
      vector,
    }
  }

  #scoreDocument(
    doc: IndexedDocument,
    terms: readonly string[],
    phraseNeedles: readonly string[],
    queryText: string,
    queryVector: readonly number[] | null,
  ): Omit<QueryResult, 'score'> & { embeddingScore: number | null } {
    let lexicalScore = 0
    const matchedTerms: string[] = []
    const matchedSkills: string[] = []

    for (const term of terms) {
      const tf = doc.termFreq.get(term)
      if (tf === undefined) continue
      matchedTerms.push(term)
      const idf = this.#idf.get(term) ?? 0
      const denom =
        tf + K1 * (1 - B + (B * (this.#averageLength > 0 ? doc.weightedLength / this.#averageLength : 1)))
      lexicalScore += idf * ((tf * (K1 + 1)) / denom)

      if (doc.skillSlugs.has(term) || doc.skillAtomSet.has(term)) {
        matchedSkills.push(term)
        lexicalScore += SKILL_MATCH_BONUS
      }
    }

    const lowerQuery = queryText.toLowerCase()
    for (const needle of phraseNeedles) {
      if (lowerQuery.includes(needle) && doc.phraseText.includes(needle)) {
        lexicalScore += PHRASE_MATCH_BONUS
      }
    }

    const availability = doc.profile.availability
    let adjusted = lexicalScore * AVAILABILITY_MULTIPLIER[availability]

    if (this.#penaliseInjection && doc.profile.flags.injectionSuspected) {
      adjusted *= this.#injectionPenalty
    }

    let embeddingScore: number | null = null
    if (this.#embeddingProvider && this.#embeddingWeight > 0 && doc.vector && queryVector) {
      embeddingScore = cosineToUnitInterval(cosineSimilarity(doc.vector, queryVector))
    }

    return {
      name: doc.name,
      lexicalScore: adjusted,
      embeddingScore,
      matchedTerms,
      matchedSkills: matchedSkills.sort(),
      availability,
      injectionSuspected: doc.profile.flags.injectionSuspected,
      profile: doc.profile,
    }
  }
}

/**
 * Query embeddings are memoised per (provider, text) for the lifetime of a
 * process — the same query text against a static index always embeds identically.
 */
const queryVectorCache = new WeakMap<EmbeddingProvider, Map<string, number[]>>()

/** Pre-fetch (and cache) the vector for a query string. Used by `queryVector()`. */
export async function prepareQueryVector(
  provider: EmbeddingProvider,
  queryText: string,
): Promise<number[]> {
  const cached = queryVectorCache.get(provider)?.get(queryText)
  if (cached) return cached
  const [vector] = await provider.embed([queryText])
  if (!vector) throw new Error(`Embedding provider ${provider.id} returned no vector for a query`)
  let byText = queryVectorCache.get(provider)
  if (!byText) {
    byText = new Map()
    queryVectorCache.set(provider, byText)
  }
  byText.set(queryText, vector)
  return vector
}

function computeIdf(documents: readonly IndexedDocument[]): Map<string, number> {
  const total = documents.length
  const documentFrequency = new Map<string, number>()
  for (const doc of documents) {
    for (const term of doc.termFreq.keys()) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1)
    }
  }
  const idf = new Map<string, number>()
  for (const [term, df] of documentFrequency) {
    idf.set(term, Math.log(1 + (total - df + 0.5) / (df + 0.5)))
  }
  return idf
}

/** The canonical text sent to the embedding provider for a profile. */
export function embeddingDocument(profile: CommunityProfile): string {
  const skills = profile.skills.join(', ')
  return [
    `Skills: ${skills}`,
    `Availability: ${profile.availability}`,
    `Bio: ${profile.bio}`,
  ].join('\n')
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0
  return Math.min(1, Math.max(0, value))
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}

class NeverReader implements ProfileReader {
  readProfile(): Promise<never> {
    throw new Error('This index has no reader; use refreshWithProfiles().')
  }
  readProfiles(): Promise<never> {
    throw new Error('This index has no reader; use refreshWithProfiles().')
  }
}

/** Convenience factory so callers do not need `new`. */
export function createCommunityIndex(options: CommunityIndexOptions): Promise<CommunityIndex> {
  return CommunityIndex.create(options)
}

export { PROFILE_RECORD_KEYS }
export type { Availability }