import { describe, expect, it } from 'vitest'
import { parseProfile, PROFILE_RECORD_KEYS } from '../lib/profile-schema.js'
import { mapWithConcurrency } from '../lib/ens-reader.js'
import { optionalEnv, requireEnv } from '../lib/env.js'

describe('InMemoryProfileReader behaves like the chain', () => {
  it('round-trips records and reports misses instead of throwing', async () => {
    const { InMemoryProfileReader } = await import('../lib/ens-reader.js')
    const reader = new InMemoryProfileReader({
      'a.eth': {
        [PROFILE_RECORD_KEYS.bio]: 'Writes Rust.',
        [PROFILE_RECORD_KEYS.skills]: 'rust',
        [PROFILE_RECORD_KEYS.availability]: 'available',
      },
    })

    const [found, missing] = await reader.readProfiles(['a.eth', 'b.eth'])
    expect(found?.records[PROFILE_RECORD_KEYS.skills]).toBe('rust')
    expect(missing?.records).toEqual({})
    expect(missing?.errors[0]).toContain('no records')
  })

  it('hands back copies so callers cannot mutate the source', async () => {
    const { InMemoryProfileReader } = await import('../lib/ens-reader.js')
    const reader = new InMemoryProfileReader({
      'a.eth': { [PROFILE_RECORD_KEYS.bio]: 'original' },
    })
    const [entry] = await reader.readProfiles(['a.eth'])
    if (entry) entry.records[PROFILE_RECORD_KEYS.bio] = 'mutated'
    const [again] = await reader.readProfiles(['a.eth'])
    expect(again?.records[PROFILE_RECORD_KEYS.bio]).toBe('original')
  })

  it('patch() adds, replaces and deletes a single record', async () => {
    const { InMemoryProfileReader } = await import('../lib/ens-reader.js')
    const reader = new InMemoryProfileReader({ 'a.eth': { [PROFILE_RECORD_KEYS.bio]: 'one' } })

    reader.patch('a.eth', PROFILE_RECORD_KEYS.bio, 'two')
    reader.patch('a.eth', PROFILE_RECORD_KEYS.skills, 'rust')
    expect((await reader.readProfile('a.eth')).records).toEqual({
      [PROFILE_RECORD_KEYS.bio]: 'two',
      [PROFILE_RECORD_KEYS.skills]: 'rust',
    })

    reader.patch('a.eth', PROFILE_RECORD_KEYS.skills, undefined)
    expect((await reader.readProfile('a.eth')).records).toEqual({
      [PROFILE_RECORD_KEYS.bio]: 'two',
    })
  })

  it('counts reads so refresh() can be observed', async () => {
    const { InMemoryProfileReader } = await import('../lib/ens-reader.js')
    const reader = new InMemoryProfileReader({})
    await reader.readProfiles([])
    await reader.readProfiles([])
    expect(reader.readCount).toBe(2)
  })
})

describe('mapWithConcurrency', () => {
  it('preserves order and never exceeds the limit', async () => {
    let inFlight = 0
    let peak = 0
    const result = await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7, 8], 3, async (value) => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 1))
      inFlight -= 1
      return value * 2
    })
    expect(result).toEqual([2, 4, 6, 8, 10, 12, 14, 16])
    expect(peak).toBeLessThanOrEqual(3)
  })

  it('handles an empty input', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
  })
})

describe('env helpers', () => {
  it('requireEnv names the variable and the hint when it is missing', () => {
    expect(() => requireEnv({}, 'SEPOLIA_RPC_URL', 'e.g. x')).toThrow(
      /Missing required env var SEPOLIA_RPC_URL\. e\.g\. x/,
    )
    expect(() => requireEnv({ A: '   ' }, 'A')).toThrow(/Missing required env var A/)
    expect(requireEnv({ A: '  value  ' }, 'A')).toBe('value')
  })

  it('optionalEnv treats blank as absent', () => {
    expect(optionalEnv({ A: 'x' }, 'A')).toBe('x')
    expect(optionalEnv({ A: '  ' }, 'A')).toBeUndefined()
    expect(optionalEnv({}, 'A')).toBeUndefined()
  })
})

describe('parseProfile never throws on hostile input', () => {
  it('survives very long and control-character records', () => {
    const profile = parseProfile('x.eth', {
      [PROFILE_RECORD_KEYS.bio]: 'a'.repeat(10_000),
      [PROFILE_RECORD_KEYS.skills]: 'x'.repeat(200),
      [PROFILE_RECORD_KEYS.availability]: 'available ',
    })
    expect(profile.bio.length).toBe(10_000)
    expect(profile.skills).toEqual([])
    expect(profile.availability).toBe('available')
  })

  it('drops skill slugs longer than the 64-char cap', () => {
    const profile = parseProfile('x.eth', {
      [PROFILE_RECORD_KEYS.bio]: 'b',
      [PROFILE_RECORD_KEYS.skills]: 'ok, ' + 'q'.repeat(65),
    })
    expect(profile.skills).toEqual(['ok'])
  })
})