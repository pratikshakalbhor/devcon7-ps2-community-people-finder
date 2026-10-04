import { beforeEach, describe, expect, it } from 'vitest'
import { CommunityIndex, createCommunityIndex } from '../lib/build-index.js'
import { COMMUNITY_FIXTURES, communityNames, fixtureProfileMap } from '../lib/community.js'
import { InMemoryProfileReader } from '../lib/ens-reader.js'
import { HashingEmbeddingProvider } from '../lib/embeddings.js'
import { PROFILE_RECORD_KEYS, type RawProfileRecords } from '../lib/profile-schema.js'

const PARENT = 'kenji-community.eth'
const NAMES = communityNames(PARENT)

/** Names of the members who actually declare `rust` in `community.dev.skills`. */
const RUST_SKILLED = new Set(
  COMMUNITY_FIXTURES.filter((f) => f.skills.includes('rust')).map((f) => `${f.label}.${PARENT}`),
)
/** The prompt-injection fixture: claims Rust mentorship, declares none. */
const INJECTED = `ivan.${PARENT}`

function seededReader(): InMemoryProfileReader {
  return new InMemoryProfileReader(fixtureProfileMap(PARENT))
}

describe('index construction', () => {
  it('builds from the seeded roster and indexes every usable profile', async () => {
    const reader = seededReader()
    const index = await createCommunityIndex({ reader, names: NAMES })

    expect(index.size).toBe(COMMUNITY_FIXTURES.length)
    expect(index.all().map((profile) => profile.name).sort()).toEqual([...NAMES].sort())
    expect(index.stats.terms).toBeGreaterThan(50)
    expect(index.stats.embeddingProvider).toBeNull()
    expect(index.builtAt).toBeGreaterThan(0)
    expect(reader.readCount).toBe(1)
  })

  it('reads profile data through the reader rather than from a hardcoded fixture', async () => {
    const empty = new InMemoryProfileReader({})
    const index = await createCommunityIndex({ reader: empty, names: NAMES })

    // Nine names, no records on the source: everything is unusable and skipped.
    expect(index.size).toBe(0)
    expect(index.stats.skipped).toBe(NAMES.length)
    expect(await index.query('rust mentor')).toEqual([])
  })

  it('skips unreadable profiles and records why', async () => {
    const source = fixtureProfileMap(PARENT)
    delete source[`carol.${PARENT}`]
    const warnings: string[] = []
    const index = await createCommunityIndex({
      reader: new InMemoryProfileReader(source),
      names: NAMES,
      onWarning: (message) => warnings.push(message),
    })

    expect(index.size).toBe(COMMUNITY_FIXTURES.length - 1)
    expect(index.get(`carol.${PARENT}`)).toBeUndefined()
    expect(warnings.some((message) => message.includes('carol'))).toBe(true)
  })

  it('surfaces schema warnings for malformed profiles', async () => {
    const source = fixtureProfileMap(PARENT)
    source[`erin.${PARENT}`] = {
      ...source[`erin.${PARENT}`],
      [PROFILE_RECORD_KEYS.availability]: 'kinda busy',
    }
    const index = await createCommunityIndex({
      reader: new InMemoryProfileReader(source),
      names: NAMES,
    })

    expect(index.get(`erin.${PARENT}`)?.availability).toBe('unknown')
    expect(index.stats.warnings.some((w) => w.includes('availability'))).toBe(true)
  })

  it('is deterministic: the same source and query give the same order twice', async () => {
    const reader = seededReader()
    const first = await CommunityIndex.create({ reader, names: NAMES })
    const second = await CommunityIndex.create({ reader, names: NAMES })

    const a = (await first.query('rust mentor')).map((r) => r.name)
    const b = (await second.query('rust mentor')).map((r) => r.name)
    expect(a).toEqual(b)
  })
})

describe('query: "rust mentor"', () => {
  it('ranks genuinely Rust-skilled profiles above unrelated ones', async () => {
    const index = await createCommunityIndex({ reader: seededReader(), names: NAMES })
    const results = await index.query('rust mentor', { limit: NAMES.length })

    // Five people declare Rust as a skill; four of them surface.
    expect(results.length).toBeGreaterThanOrEqual(4)
    expect(results.slice(0, 4).every((r) => RUST_SKILLED.has(r.name))).toBe(true)

    // Every profile that outranks the tail is a declared Rust dev.
    const tail = results.slice(4)
    for (const result of tail) {
      if (result.name === INJECTED) continue
      expect(RUST_SKILLED.has(result.name), `${result.name} should declare rust`).toBe(true)
    }
  })

  it('does not return unrelated people at all', async () => {
    const index = await createCommunityIndex({ reader: seededReader(), names: NAMES })
    const names = (await index.query('rust mentor', { limit: NAMES.length })).map((r) => r.name)

    // Carol (frontend/solidity), Frank (auditing) and Grace (ML) share no terms with
    // the query, so a keyword index correctly leaves them out rather than padding.
    expect(names).not.toContain(`carol.${PARENT}`)
    expect(names).not.toContain(`frank.${PARENT}`)
    expect(names).not.toContain(`grace.${PARENT}`)
  })

  it('orders a broad query by relevance rather than returning everyone', async () => {
    const index = await createCommunityIndex({ reader: seededReader(), names: NAMES })
    const results = await index.query('engineer', { limit: NAMES.length })

    // "engineer" appears in six bios. Bob, Frank and Ivan never say it.
    expect(results.length).toBeGreaterThanOrEqual(5)
    expect(results.map((r) => r.name)).not.toContain(`frank.${PARENT}`)
    expect(results.map((r) => r.name)).not.toContain(INJECTED)
    expect(results[0]?.score).toBeGreaterThan(results[results.length - 1]?.score ?? 0)

    // Erin is the only unavailable match, so she sorts last despite being Rust-skilled.
    expect(results[results.length - 1]?.name).toBe(`erin.${PARENT}`)

    // A different query retrieves a different, correct answer.
    const security = await index.query('security audit', { limit: 1 })
    expect(security[0]?.name).toBe(`frank.${PARENT}`)
  })

  it('puts the actual mentor first', async () => {
    const index = await createCommunityIndex({ reader: seededReader(), names: NAMES })
    const results = await index.query('rust mentor', { limit: 3 })
    expect(results[0]?.name).toBe(`heidi.${PARENT}`)
    expect(results[0]?.matchedSkills).toEqual(expect.arrayContaining(['rust', 'mentor']))
    expect(results[0]?.profile.availability).toBe('available')
  })

  it('matches "mentoring" and "coaching" onto the mentor query', async () => {
    const source: Record<string, RawProfileRecords> = {
      'a.eth': {
        [PROFILE_RECORD_KEYS.bio]: 'I coach people who write Rust.',
        [PROFILE_RECORD_KEYS.skills]: 'rust',
        [PROFILE_RECORD_KEYS.availability]: 'available',
      },
      'b.eth': {
        [PROFILE_RECORD_KEYS.bio]: 'Rust is fine.',
        [PROFILE_RECORD_KEYS.skills]: 'rust',
        [PROFILE_RECORD_KEYS.availability]: 'available',
      },
    }
    const index = await createCommunityIndex({
      reader: new InMemoryProfileReader(source),
      names: ['a.eth', 'b.eth'],
    })
    const results = await index.query('rust mentor')
    expect(results[0]?.name).toBe('a.eth')
  })

  it('demotes unavailable people without hiding them', async () => {
    const index = await createCommunityIndex({ reader: seededReader(), names: NAMES })
    const results = await index.query('rust', { limit: NAMES.length })

    const erin = results.find((r) => r.name === `erin.${PARENT}`)
    const dave = results.find((r) => r.name === `dave.${PARENT}`)
    expect(erin).toBeDefined()
    expect(dave).toBeDefined()
    expect(erin?.profile.availability).toBe('unavailable')
    expect((erin?.score ?? 0)).toBeLessThan(dave?.score ?? 0)
  })

  it('can filter by availability', async () => {
    const index = await createCommunityIndex({ reader: seededReader(), names: NAMES })
    const results = await index.query('rust', { availability: ['available'] })
    expect(results.length).toBeGreaterThan(0)
    for (const result of results) expect(result.availability).toBe('available')
  })

  it('returns nothing for a stopword-only query', async () => {
    const index = await createCommunityIndex({ reader: seededReader(), names: NAMES })
    expect(await index.query('the and of')).toEqual([])
  })
})

describe('prompt-injection fixture', () => {
  it('does not let an injected bio buy the top ranking', async () => {
    const index = await createCommunityIndex({ reader: seededReader(), names: NAMES })
    const results = await index.query('rust mentor', { limit: NAMES.length })

    const ivan = results.find((r) => r.name === INJECTED)
    const heidi = results.find((r) => r.name === `heidi.${PARENT}`)

    expect(ivan?.injectionSuspected).toBe(true)
    expect(ivan?.profile.flags.injectionPatterns.length).toBeGreaterThan(0)
    expect(ivan).toBeDefined()
    expect(heidi).toBeDefined()
    expect(heidi!.score).toBeGreaterThan(ivan!.score)

    // He is demoted below every genuine Rust developer, despite his bio claiming to
    // be the best Rust mentor in the community.
    const rustPeople = results.filter((r) => RUST_SKILLED.has(r.name))
    for (const person of rustPeople) {
      expect(person.score).toBeGreaterThan(ivan!.score)
    }
    expect(results.slice(0, 3).map((r) => r.name)).not.toContain(INJECTED)
  })

  it('still finds him for what he actually declares', async () => {
    const index = await createCommunityIndex({ reader: seededReader(), names: NAMES })
    const results = await index.query('community events', { limit: 2 })
    expect(results[0]?.name).toBe(INJECTED)
    // Still findable, just not promoted above everyone.
    expect(results[0]?.injectionSuspected).toBe(true)
  })

  it('can be turned off for inspection', async () => {
    const penalised = await createCommunityIndex({ reader: seededReader(), names: NAMES })
    const unpenalised = await createCommunityIndex({
      reader: seededReader(),
      names: NAMES,
      penaliseSuspectedInjection: false,
    })

    const find = async (index: CommunityIndex, name: string) =>
      (await index.query('rust mentor', { limit: NAMES.length })).find((r) => r.name === name)

    const withPenalty = await find(penalised, INJECTED)
    const without = await find(unpenalised, INJECTED)

    expect(withPenalty).toBeDefined()
    expect(without).toBeDefined()
    // Same profile, lower score, purely because the bio tried to game a reader.
    expect(withPenalty!.score).toBeLessThan(without!.score)
  })
})

describe('refresh()', () => {
  let reader: InMemoryProfileReader
  let index: CommunityIndex

  beforeEach(async () => {
    reader = seededReader()
    index = await createCommunityIndex({ reader, names: NAMES })
  })

  it('re-reads every profile from the source', async () => {
    expect(reader.readCount).toBe(1)
    await index.refresh()
    expect(reader.readCount).toBe(2)
    expect(index.size).toBe(COMMUNITY_FIXTURES.length)
  })

  it('is idempotent when nothing changed', async () => {
    const before = await index.query('rust mentor', { limit: NAMES.length })
    await index.refresh()
    const after = await index.query('rust mentor', { limit: NAMES.length })

    expect(after.map((r) => [r.name, r.score.toFixed(6)])).toEqual(
      before.map((r) => [r.name, r.score.toFixed(6)]),
    )
  })

  it("picks up a changed bio in the very next query", async () => {
    const target = `grace.${PARENT}`

    // Grace is a Python/ML person today: she is not a candidate for a Rust query.
    expect((await index.query('rust mentor', { limit: NAMES.length })).map((r) => r.name)).not.toContain(
      target,
    )
    expect((await index.query('rust mentor', { limit: NAMES.length }))[0]?.name).toBe(
      `heidi.${PARENT}`,
    )

    // Grace rewrites her ENS profile on chain: new bio, new skills, available.
    reader.set(target, {
      [PROFILE_RECORD_KEYS.bio]: 'Now I maintain a Rust compiler and mentor on it.',
      [PROFILE_RECORD_KEYS.skills]: 'rust, compilers, mentoring',
      [PROFILE_RECORD_KEYS.availability]: 'available',
    })

    // The in-memory index is still stale — this is the point of refresh().
    expect((await index.query('rust mentor', { limit: NAMES.length })).map((r) => r.name)).not.toContain(
      target,
    )

    await index.refresh()

    const after = await index.query('rust mentor', { limit: NAMES.length })
    expect(after.map((r) => r.name)).toContain(target)
    expect(after[1]?.name).toBe(target)
    expect(after[1]?.matchedSkills).toEqual(expect.arrayContaining(['rust', 'mentor']))
    expect(index.get(target)?.bio).toContain('Rust compiler')
  })

  it('picks up a skills change, not just a bio change', async () => {
    const target = `carol.${PARENT}`
    reader.set(target, {
      [PROFILE_RECORD_KEYS.bio]: 'Picked up Rust last month. Learning fast.',
      [PROFILE_RECORD_KEYS.skills]: 'rust, solidity, typescript',
      [PROFILE_RECORD_KEYS.availability]: 'available',
    })
    await index.refresh()

    const results = await index.query('rust', { limit: NAMES.length })
    const carol = results.find((r) => r.name === target)
    const grace = results.find((r) => r.name === `grace.${PARENT}`)
    expect(carol?.score ?? 0).toBeGreaterThan(grace?.score ?? 0)
    expect(carol?.matchedSkills).toContain('rust')
  })

  it('reflects an availability upgrade', async () => {
    const target = `bob.${PARENT}`
    reader.patch(target, PROFILE_RECORD_KEYS.availability, 'available')
    await index.refresh()
    expect(index.get(target)?.availability).toBe('available')
  })

  it('drops a profile whose records disappear', async () => {
    reader.delete(`frank.${PARENT}`)
    await index.refresh()
    expect(index.size).toBe(COMMUNITY_FIXTURES.length - 1)
    expect(index.get(`frank.${PARENT}`)).toBeUndefined()
    // Frank was the only security person; the remaining match is Carol's word "audited".
    const results = await index.query('smart contract auditing', { limit: NAMES.length })
    expect(results.map((r) => r.name)).not.toContain(`frank.${PARENT}`)
  })

  it('re-indexes a profile that becomes unusable', async () => {
    reader.set(`erin.${PARENT}`, {
      [PROFILE_RECORD_KEYS.availability]: 'unavailable',
    })
    await index.refresh()
    expect(index.get(`erin.${PARENT}`)).toBeUndefined()
    expect(index.size).toBe(COMMUNITY_FIXTURES.length - 1)
  })
})

describe('optional dense retrieval', () => {
  it('blends a cosine signal without changing the leader', async () => {
    const provider = new HashingEmbeddingProvider()
    const lexical = await createCommunityIndex({ reader: seededReader(), names: NAMES })
    const hybrid = await createCommunityIndex({
      reader: seededReader(),
      names: NAMES,
      embeddingProvider: provider,
      embeddingWeight: 0.3,
    })

    expect(hybrid.stats.embeddingProvider).toBe(provider.id)
    const hybridResults = await hybrid.query('rust mentor', { limit: 3 })
    const lexicalResults = await lexical.query('rust mentor', { limit: 3 })
    expect(hybridResults[0]?.name).toBe(lexicalResults[0]?.name)
    expect(hybridResults[0]?.embeddingScore).toBeGreaterThan(0)
    // Blended scores are on a 0..1 scale, not raw BM25 sums.
    expect(hybridResults[0]?.score).toBeLessThanOrEqual(1)
  })

  it('works end to end with refresh()', async () => {
    const provider = new HashingEmbeddingProvider()
    const reader = seededReader()
    const index = await createCommunityIndex({
      reader,
      names: NAMES,
      embeddingProvider: provider,
    })
    await index.refresh()
    expect((await index.query('rust mentor')).length).toBeGreaterThan(0)
  })
})