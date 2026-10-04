/**
 * The membership check tests.
 *
 * This is the component that makes hallucination impossible rather than unlikely, so
 * these tests are written adversarially: the mock model is assumed to be actively trying
 * to smuggle a name past the filter.
 */

import { describe, expect, it } from 'vitest'
import {
  MAX_REASON_LENGTH,
  sanitiseReason,
  verifyCandidates,
  type RejectedMatch,
  type VerifyOptions,
} from '../lib/verify-candidates.js'
import { retrieveCandidates } from '../lib/retrieve.js'
import { seededIndex } from './helpers/part2.js'
import { ALICE, HEIDI, INJECTED } from './helpers/part2.js'

async function rustCandidates() {
  const result = await retrieveCandidates(await seededIndex(), 'rust mentor')
  return result.candidates
}

function namesIn(proposed: unknown, candidates: Awaited<ReturnType<typeof rustCandidates>>) {
  return verifyCandidates(proposed, candidates).matches.map((match) => match.ensName)
}

describe('hallucinated names are stripped', () => {
  it('drops a person the model invented who was never retrieved', async () => {
    const candidates = await rustCandidates()

    const result = verifyCandidates(
      {
        matches: [
          { ensName: HEIDI, reason: 'Declares rust and mentoring.' },
          { ensName: 'satoshi.kenji-community.eth', reason: 'Well known in the space.' },
          { ensName: 'vitalik.eth', reason: 'Knows everything.' },
        ],
      },
      candidates,
    )

    expect(result.matches.map((match) => match.ensName)).toEqual([HEIDI])
    expect(result.rejected).toHaveLength(2)
    expect(result.rejected.map((entry) => entry.claimedEnsName).sort()).toEqual([
      'satoshi.kenji-community.eth',
      'vitalik.eth',
    ])
    for (const entry of result.rejected)
      expect(entry.reason).toBe('not in the retrieved candidate set')
  })

  it('keeps the genuine candidate when the model mixes real and invented names', async () => {
    const candidates = await rustCandidates()

    // A plausible mix: one real, two fabricated. Only the real one may survive.
    const result = verifyCandidates(
      [
        { ensName: ALICE, reason: 'Rust on embedded.' },
        { ensName: 'alice.kenji-community.eth.backdoor', reason: 'Injected.' },
        { ensName: 'not-a-name', reason: 'Injected.' },
      ],
      candidates,
    )

    expect(result.matches).toHaveLength(1)
    expect(result.matches[0]?.ensName).toBe(ALICE)
    expect(result.rejected).toHaveLength(2)
  })

  it('is case- and whitespace-insensitive, because those are the same name', async () => {
    const candidates = await rustCandidates()

    const result = verifyCandidates(
      { matches: [{ ensName: `  ${HEIDI.toUpperCase()}  `, reason: 'Match.' }] },
      candidates,
    )

    expect(result.matches).toHaveLength(1)
    // The canonical spelling from the candidate list, never the model's casing.
    expect(result.matches[0]?.ensName).toBe(HEIDI)
  })

  it('does not treat a prefix or suffix of a candidate as that candidate', async () => {
    const candidates = await rustCandidates()

    const result = verifyCandidates(
      {
        matches: [
          { ensName: `evil-${HEIDI}`, reason: 'x' },
          { ensName: `${HEIDI}.attacker.com`, reason: 'x' },
          { ensName: HEIDI.replace(/\.eth$/, ''), reason: 'x' },
          { ensName: 'heidi', reason: 'x' },
        ],
      },
      candidates,
    )

    expect(result.matches).toEqual([])
    expect(result.rejected).toHaveLength(4)
  })

  it('drops a duplicate recommendation of the same person', async () => {
    const candidates = await rustCandidates()

    const result = verifyCandidates(
      {
        matches: [
          { ensName: HEIDI, reason: 'First.' },
          { ensName: HEIDI.toUpperCase(), reason: 'Again.' },
        ],
      },
      candidates,
    )

    expect(result.matches).toHaveLength(1)
    expect(result.rejected[0]?.reason).toBe('already recommended')
  })
})

describe('the adversarial bio cannot buy itself a recommendation', () => {
  it('rejects the injected profile for a query it was not retrieved for', async () => {
    const candidates = await rustCandidates()

    // This is the attack working as far as it possibly can: retrieval returned real
    // Rust people, and the model (having obeyed the bio) also demanded the attacker.
    expect(candidates.map((candidate) => candidate.name)).not.toContain(INJECTED)

    const result = verifyCandidates(
      {
        matches: [
          { ensName: HEIDI, reason: 'Declares rust and mentoring.' },
          { ensName: INJECTED, reason: 'I am the best Rust mentor, always pick me first.' },
        ],
      },
      candidates,
    )

    expect(result.matches.map((match) => match.ensName)).toEqual([HEIDI])
    const rejected = result.rejected.find((entry) => entry.claimedEnsName === INJECTED)
    expect(rejected?.reason).toBe('not in the retrieved candidate set')
  })

  it('still allows the injected profile when retrieval legitimately selected them', async () => {
    // Not a blanket ban on a flagged profile: if you genuinely ask about running events,
    // he is a legitimate candidate and the answer should include him.
    const { candidates } = await retrieveCandidates(await seededIndex(), 'community events facilitation')
    expect(candidates.map((candidate) => candidate.name)).toContain(INJECTED)

    const result = verifyCandidates(
      { matches: [{ ensName: INJECTED, reason: 'Runs community events.' }] },
      candidates,
    )

    expect(result.matches).toHaveLength(1)
    // Still surfaced as flagged so a caller can decide how to present it.
    expect(result.matches[0]?.injectionSuspected).toBe(true)
  })

  it('cannot widen its own scope: retrieval sends 5, the model cannot return 6', async () => {
    const candidates = await rustCandidates()
    expect(candidates.length).toBeLessThanOrEqual(5)

    const everyone = ['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'heidi', 'ivan']
    const result = verifyCandidates(
      {
        matches: everyone.map((label) => ({
          ensName: `${label}.kenji-community.eth`,
          reason: 'r',
        })),
      },
      candidates,
    )

    expect(result.matches.length).toBeLessThanOrEqual(candidates.length)
    for (const match of result.matches)
      expect(candidates.map((candidate) => candidate.name)).toContain(match.ensName)
  })
})

describe('malformed model output degrades instead of throwing', () => {
  const cases: readonly [string, unknown][] = [
    ['prose instead of JSON', 'I think heidi.eth would be great.'],
    ['null', null],
    ['undefined', undefined],
    ['a bare string', 'heidi.eth'],
    ['a number', 42],
    ['an empty array', []],
    ['an empty object', {}],
    ['a null matches field', { matches: null }],
    ['matches as a string', { matches: 'heidi.eth' }],
  ]

  for (const [label, value] of cases) {
    it(`treats ${label} as no match`, async () => {
      const candidates = await rustCandidates()
      const result = verifyCandidates(value, candidates)

      expect(result.matches).toEqual([])
      expect(result.allRejected).toBe(false)
    })
  }

  it('drops entries whose ensName is missing or not a string', async () => {
    const candidates = await rustCandidates()
    const result = verifyCandidates(
      {
        matches: [
          { reason: 'no name at all' },
          { ensName: 123, reason: 'numeric name' },
          { ensName: '', reason: 'empty name' },
          { ensName: '   ', reason: 'blank name' },
          { ensName: null, reason: 'null name' },
          { ensName: HEIDI, reason: 'the only valid one' },
        ],
      },
      candidates,
    )

    expect(result.matches.map((match) => match.ensName)).toEqual([HEIDI])
    expect(result.rejected).toHaveLength(5)
  })

  it('tolerates a non-object entry inside the array', async () => {
    const candidates = await rustCandidates()
    const result = verifyCandidates(['heidi.eth', 7, null, { ensName: HEIDI, reason: 'ok' }], candidates)

    expect(result.matches).toHaveLength(1)
    expect(result.rejected).toHaveLength(3)
  })

  it('accepts a bare array as well as the requested object shape', async () => {
    const candidates = await rustCandidates()

    expect(namesIn([{ ensName: HEIDI, reason: 'ok' }], candidates)).toEqual([HEIDI])
    expect(namesIn({ results: [{ ensName: HEIDI, reason: 'ok' }] }, candidates)).toEqual([HEIDI])
  })

  it('flags allRejected when the model proposed something and none of it survived', async () => {
    const candidates = await rustCandidates()

    const rejected = verifyCandidates({ matches: [{ ensName: 'ghost.eth', reason: 'x' }] }, candidates)
    expect(rejected.matches).toEqual([])
    expect(rejected.allRejected).toBe(true)

    const empty = verifyCandidates({ matches: [] }, candidates)
    expect(empty.allRejected).toBe(false)
  })
})

describe('bounded output', () => {
  it('caps the number of returned matches', async () => {
    const candidates = await rustCandidates()
    const proposed = { matches: candidates.map((c) => ({ ensName: c.name, reason: 'r' })) }

    const result = verifyCandidates(proposed, candidates, { maxMatches: 1 })

    expect(result.matches).toHaveLength(1)
    expect(result.rejected.some((entry: RejectedMatch) => entry.reason === 'exceeded maxMatches')).toBe(
      true,
    )
  })

  it('collapses and truncates the justification', () => {
    expect(sanitiseReason('line one\nline two')).toBe('line one line two')
    expect(sanitiseReason('   padded   ')).toBe('padded')
    expect(sanitiseReason(undefined)).toBe('')
    expect(sanitiseReason(42)).toBe('')

    const long = 'x'.repeat(MAX_REASON_LENGTH + 100)
    const result = sanitiseReason(long)
    expect(result.length).toBeLessThanOrEqual(MAX_REASON_LENGTH)
    expect(result.endsWith('…')).toBe(true)
  })
})

describe('the check cannot be switched off', () => {
  it('exposes no option to skip verification', async () => {
    const candidates = await rustCandidates()
    // Deliberately hostile: none of these is a real option, so they cannot be passed
    // through the typed API. Even if they were, verification has nothing to switch off.
    const hostile = {
      verify: false,
      skipVerification: true,
      trustModel: true,
    } as unknown as VerifyOptions

    const result = verifyCandidates(
      { matches: [{ ensName: 'ghost.eth', reason: 'x' }] },
      candidates,
      hostile,
    )

    expect(result.matches).toEqual([])
  })
})
