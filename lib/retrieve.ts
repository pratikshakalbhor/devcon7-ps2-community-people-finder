/**
 * Bounded candidate retrieval.
 *
 * Turns a free-text question into a *small, fixed-size* set of candidate profiles. Two
 * properties are the whole point of this file:
 *
 *  1. **The candidate set is bounded by a named constant.** `TOP_K_CANDIDATES` caps it
 *     no matter how large the community grows. Passing the whole roster to the model
 *     would grow the prompt, the cost, and the chance of a stray match with every new
 *     member, so "just send everyone" is never the fallback.
 *
 *  2. **Weak matches are dropped, not ranked low.** A community has some member for
 *     almost any question ("who knows Rust?" in a nine-person community has an answer).
 *     Returning the least-bad of them is worse than saying nobody matches, because the
 *     model will dutifully write a confident sentence about whoever we handed it. So
 *     two independent gates must both pass before a profile becomes a candidate.
 *
 * ---------------------------------------------------------------------------
 * Why two gates, and why a ratio
 * ---------------------------------------------------------------------------
 * `MIN_RELEVANCE_FRACTION` is a fraction of the best score in this result set, not an
 * absolute number. That is deliberate: `CommunityIndex.query()` returns raw BM25 sums
 * (roughly 0.4 to 12 on the seeded fixtures) when it is lexical-only, but a normalised
 * 0..1 blend when embeddings are enabled. Any absolute threshold would mean something
 * completely different in the two modes. A ratio is scale-free, so one constant is
 * correct for both.
 *
 * A ratio alone has a failure mode: if every candidate scores ~0, they all sit at
 * ratio 1.0 and the gate passes them all. That is what the evidence gate is for — a
 * candidate must have actually matched a query term. "Match nothing" can never be
 * "relatively the best thing we found".
 */

import type { CommunityIndex, QueryResult } from './build-index.js'
import type { CommunityProfile, ProfileAvailability } from './profile-schema.js'
import { BadQueryError, canonicalizeEnsName } from './normalize-ens-name.js'

/**
 * Hard ceiling on how many candidates reach the model.
 *
 * Named, not derived from community size. Nine members or nine thousand, five go in.
 */
export const TOP_K_CANDIDATES = 5

/**
 * A candidate must score at least this fraction of the best score in the same result
 * set.
 *
 * 0.25 keeps the clear winners and drops the tail. The seeded fixtures put the spread
 * between the best match and the next unrelated-but-non-zero profile well above 4x, so
 * 0.25 separates "these people can help" from "this person once mentioned the word"
 * without being knife-edge.
 */
export const MIN_RELEVANCE_FRACTION = 0.25

export interface RetrieveOptions {
  /**
   * Override `TOP_K_CANDIDATES`. Values <= 0 are rejected rather than clamped, because a
   * silent clamp would hide a configuration bug behind plausible output.
   */
  readonly topK?: number
  /** Override `MIN_RELEVANCE_FRACTION`. Must be within (0, 1]. */
  readonly minRelevanceFraction?: number
  /** Restrict to these availability tiers before ranking. */
  readonly availability?: readonly ProfileAvailability[]
}

export interface Candidate {
  /** ENS name, exactly as it appears in the index. */
  readonly name: string
  /** Canonical (lowercased) form, used for membership checks. */
  readonly canonicalName: string
  /** The profile as parsed from chain. Treated as untrusted throughout. */
  readonly profile: CommunityProfile
  readonly score: number
  /** Score as a fraction of the best candidate. Exactly 1 for the top candidate. */
  readonly relativeScore: number
  readonly matchedTerms: readonly string[]
  readonly matchedSkills: readonly string[]
  readonly availability: ProfileAvailability
  /**
   * True when the bio tripped the injection heuristics in `lib/profile-schema.ts`.
   *
   * Carried through so a caller can decide what to do; retrieval itself neither drops
   * nor trusts these profiles, because a flagged bio is still valid data and the real
   * defences are the scoring penalty (Part 1) and the membership check (Part 2).
   */
  readonly injectionSuspected: boolean
}

export interface RetrievalResult {
  readonly query: string
  /** Always `<= topK`, often 0. */
  readonly candidates: readonly Candidate[]
  /** Why the candidate list came out the way it did. Useful in tests and logs. */
  readonly diagnostics: RetrievalDiagnostics
}

export interface RetrievalDiagnostics {
  /** Profiles the index ranked above zero for this query. */
  readonly considered: number
  /** Profiles dropped for not matching any query term. */
  readonly droppedNoEvidence: number
  /** Profiles dropped for scoring under `MIN_RELEVANCE_FRACTION` of the best. */
  readonly droppedLowRelevance: number
  /** Profiles dropped purely because the list was capped at `topK`. */
  readonly droppedByCap: number
  /** Highest raw score seen, even if every candidate was later dropped. */
  readonly bestScore: number
}

function assertQuery(query: string): string {
  if (typeof query !== 'string' || query.trim() === '')
    throw new BadQueryError('The query is empty. Provide a non-empty string to search for.')
  return query.trim()
}

function resolveTopK(value: number | undefined): number {
  if (value === undefined) return TOP_K_CANDIDATES
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new BadQueryError(`topK must be a positive integer, received ${JSON.stringify(value)}.`)
  return value
}

function resolveFraction(value: number | undefined): number {
  if (value === undefined) return MIN_RELEVANCE_FRACTION
  if (!Number.isFinite(value) || value <= 0 || value > 1)
    throw new BadQueryError(
      `minRelevanceFraction must be within (0, 1], received ${JSON.stringify(value)}.`,
    )
  return value
}

/**
 * Retrieves the candidate set for a question.
 *
 * @param index A built `CommunityIndex` from Part 1.
 * @param query Free-text question.
 * @returns At most `topK` candidates, possibly none. Never throws for "nothing matched"
 * — an empty `candidates` array is a normal, expected outcome, not an error.
 */
export async function retrieveCandidates(
  index: CommunityIndex,
  query: string,
  options: RetrieveOptions = {},
): Promise<RetrievalResult> {
  const text = assertQuery(query)
  const topK = resolveTopK(options.topK)
  const minFraction = resolveFraction(options.minRelevanceFraction)

  // Ask the index for exactly what we could use. `limit: topK` is deliberate and is the
  // reason the candidate set cannot grow with the community: the index is never asked
  // for more than we are willing to send.
  const ranked = await index.query(text, {
    limit: topK,
    minScore: 0,
    ...(options.availability ? { availability: options.availability } : {}),
  })

  if (ranked.length === 0) {
    return {
      query: text,
      candidates: [],
      diagnostics: {
        considered: 0,
        droppedNoEvidence: 0,
        droppedLowRelevance: 0,
        droppedByCap: 0,
        bestScore: 0,
      },
    }
  }

  const bestScore = ranked.reduce((max, result) => Math.max(max, result.score), 0)
  const floor = bestScore * minFraction

  let droppedNoEvidence = 0
  let droppedLowRelevance = 0
  const passing: QueryResult[] = []

  for (const result of ranked) {
    // Gate 1: real evidence. Guards the case where every score is ~0 and the ratio
    // gate would otherwise wave them all through.
    if (result.matchedTerms.length === 0) {
      droppedNoEvidence += 1
      continue
    }
    // Gate 2: relative relevance.
    if (result.score < floor) {
      droppedLowRelevance += 1
      continue
    }
    passing.push(result)
  }

  // Gate 3: the cap. Applied last so the caps reflect the strongest candidates.
  const capped = passing.slice(0, topK)

  return {
    query: text,
    candidates: capped.map((result) => toCandidate(result, bestScore)),
    diagnostics: {
      considered: ranked.length,
      droppedNoEvidence,
      droppedLowRelevance,
      droppedByCap: passing.length - capped.length,
      bestScore,
    },
  }
}

function toCandidate(result: QueryResult, bestScore: number): Candidate {
  return {
    name: result.name,
    canonicalName: canonicalizeEnsName(result.name),
    profile: result.profile,
    score: result.score,
    relativeScore: bestScore > 0 ? result.score / bestScore : 0,
    matchedTerms: [...result.matchedTerms],
    matchedSkills: [...result.matchedSkills],
    availability: result.availability,
    injectionSuspected: result.injectionSuspected,
  }
}

/**
 * The candidate set as a plain name list — the input to `verifyCandidates()`.
 *
 * Exported so the membership check and its tests cannot accidentally disagree about
 * which names are admissible.
 */
export function candidateNames(candidates: readonly Candidate[]): readonly string[] {
  return candidates.map((candidate) => candidate.name)
}
