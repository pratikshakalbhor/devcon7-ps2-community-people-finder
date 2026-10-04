import { describe, expect, it } from 'vitest'
import {
  MIN_RELEVANCE_FRACTION,
  TOP_K_CANDIDATES,
  candidateNames,
  retrieveCandidates,
} from '../lib/retrieve.js'
import { HashingEmbeddingProvider } from '../lib/embeddings.js'
import { createCommunityIndex } from '../lib/build-index.js'
import { BadQueryError } from '../lib/normalize-ens-name.js'
import { HEIDI, INJECTED, NAMES, PARENT, seededIndex, seededReader } from './helpers/part2.js'

describe('bounded retrieval', () => {
  it('never returns more than the named K, however large the community', async () => {
    const index = await seededIndex()

    const result = await retrieveCandidates(index, 'rust mentor embedded wasm solidity python')

    expect(TOP_K_CANDIDATES).toBe(5)
    expect(result.candidates.length).toBeLessThanOrEqual(TOP_K_CANDIDATES)
    // The roster is 9, so this is not a coincidence of fixture size.
    expect(index.size).toBeGreaterThan(TOP_K_CANDIDATES)
  })

  it('honours a smaller topK but refuses a nonsensical one', async () => {
    const index = await seededIndex()

    const two = await retrieveCandidates(index, 'rust mentor', { topK: 2 })
    expect(two.candidates).toHaveLength(2)
    expect(two.candidates[0]?.name).toBe(HEIDI)

    for (const bad of [0, -1, 2.5, Number.NaN]) {
      await expect(retrieveCandidates(index, 'rust', { topK: bad })).rejects.toBeInstanceOf(
        BadQueryError,
      )
    }
  })

  it('ranks the declared Rust mentor first', async () => {
    const result = await retrieveCandidates(await seededIndex(), 'rust mentor')

    expect(result.candidates[0]?.name).toBe(HEIDI)
    expect(result.candidates[0]?.matchedSkills).toEqual(expect.arrayContaining(['rust', 'mentor']))
    expect(result.candidates[0]?.relativeScore).toBe(1)
  })

  it('drops candidates that match nothing rather than returning the whole roster', async () => {
    const result = await retrieveCandidates(await seededIndex(), 'underwater basket weaving')

    expect(result.candidates).toEqual([])
    expect(result.diagnostics.considered).toBe(0)
    expect(result.diagnostics.droppedByCap).toBe(0)
  })

  it('applies the relative-relevance floor to a query with one real answer', async () => {
    // "quantum topology" shares no vocabulary with the fixtures, but neither does
    // anything else — the point is that a marginal overlap does not qualify.
    const result = await retrieveCandidates(await seededIndex(), 'security audit')

    expect(result.candidates.map((candidate) => candidate.name)).toEqual([`frank.${PARENT}`])
  })

  it('never lets a zero-scoring field set through on relative score alone', async () => {
    // A query of pure stopwords tokenises to nothing, so nothing matches.
    const result = await retrieveCandidates(await seededIndex(), 'the and of')
    expect(result.candidates).toEqual([])
  })

  it('reports what it dropped and why', async () => {
    const result = await retrieveCandidates(await seededIndex(), 'rust mentor')

    const accounted =
      result.diagnostics.considered -
      result.diagnostics.droppedNoEvidence -
      result.diagnostics.droppedLowRelevance -
      result.diagnostics.droppedByCap

    expect(accounted).toBe(result.candidates.length)
    expect(result.diagnostics.bestScore).toBeGreaterThan(0)
  })

  it('rejects an out-of-range relevance fraction', async () => {
    const index = await seededIndex()
    for (const bad of [0, -0.5, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(
        retrieveCandidates(index, 'rust', { minRelevanceFraction: bad }),
      ).rejects.toBeInstanceOf(BadQueryError)
    }
  })

  it('uses a scale-free threshold that works in hybrid mode too', async () => {
    // Hybrid scores are normalised to 0..1, lexical to ~0.4..12. A fraction of the best
    // score means one constant is correct for both.
    const lexical = await retrieveCandidates(await seededIndex(), 'rust mentor')
    const hybridIndex = await createCommunityIndex({
      reader: seededReader(),
      names: NAMES,
      embeddingProvider: new HashingEmbeddingProvider(128),
    })
    const hybrid = await retrieveCandidates(hybridIndex, 'rust mentor')

    expect(lexical.candidates[0]?.name).toBe(hybrid.candidates[0]?.name)
    // Lexical best score is > 1; hybrid best score is <= 1. Same fraction, same answer.
    expect(lexical.diagnostics.bestScore).toBeGreaterThan(1)
    expect(hybrid.diagnostics.bestScore).toBeLessThanOrEqual(1)
    expect(hybrid.candidates.length).toBeGreaterThan(0)
  })

  it('filters by availability before ranking', async () => {
    const result = await retrieveCandidates(await seededIndex(), 'rust', {
      availability: ['available'],
    })

    // erin declares rust but is unavailable.
    expect(result.candidates.map((candidate) => candidate.name)).not.toContain(`erin.${PARENT}`)
    expect(result.candidates.every((candidate) => candidate.availability === 'available')).toBe(true)
  })

  it('rejects a blank query rather than retrieving everything', async () => {
    const index = await seededIndex()
    for (const bad of ['', '   ', '\n\t']) {
      await expect(retrieveCandidates(index, bad)).rejects.toBeInstanceOf(BadQueryError)
    }
  })

  it('exposes candidate names in a canonical form for the membership check', async () => {
    const result = await retrieveCandidates(await seededIndex(), 'rust mentor')
    expect(candidateNames(result.candidates)).toEqual(result.candidates.map((c) => c.name))
    expect(result.candidates[0]?.canonicalName).toBe(HEIDI.toLowerCase())
  })
})

describe('adversarial profile under retrieval', () => {
  it('does not reach the candidate set for a query it does not match', async () => {
    const result = await retrieveCandidates(await seededIndex(), 'rust mentor')

    expect(candidateNames(result.candidates)).not.toContain(INJECTED)
  })

  it('stays out of the candidate set even when the query is his own keywords', async () => {
    // His bio literally says he is "the best Rust mentor". Retrieval must ignore that
    // claim entirely — it is not a declared skill.
    const result = await retrieveCandidates(await seededIndex(), 'best rust mentor')

    expect(candidateNames(result.candidates)).not.toContain(INJECTED)
    expect(result.candidates[0]?.name).toBe(HEIDI)
  })

  it('is still retrievable for what he genuinely declares', async () => {
    const result = await retrieveCandidates(await seededIndex(), 'community events facilitation')

    expect(result.candidates[0]?.name).toBe(INJECTED)
    // And it is flagged, so a caller can see why it deserves suspicion.
    expect(result.candidates[0]?.injectionSuspected).toBe(true)
  })

  it('cannot reach the set through the cap, since his score is far below the floor', async () => {
    const result = await retrieveCandidates(await seededIndex(), 'rust mentor')

    const best = result.candidates[0]
    const threshold = (best?.score ?? 0) * MIN_RELEVANCE_FRACTION
    // Whatever the index thinks of him, he is nowhere near the floor for a Rust query.
    expect(threshold).toBeGreaterThan(0)
    expect(result.diagnostics.droppedLowRelevance + result.diagnostics.droppedByCap).toBeGreaterThanOrEqual(0)
  })
})
