/**
 * Reading community profiles off ENS.
 *
 * The index builder never touches viem directly — it talks to a `ProfileReader`.
 * That keeps the retrieval code testable offline (see `InMemoryProfileReader`)
 * while the production path is genuine live-chain `getEnsText` reads.
 */
import type { Chain, PublicClient as ViemPublicClient, Transport } from 'viem'
import { createPublicClient, http as httpTransport } from 'viem'
import { getEnsAddress, getEnsText } from 'viem/actions'
import {
  PROFILE_RECORD_KEY_LIST,
  parseProfile,
  type CommunityProfile,
  type ProfileRecordKey,
  type RawProfileRecords,
} from './profile-schema.js'
import { SEPOLIA_CHAIN as sepolia } from './chain.js'

/** A profile exactly as stored on chain, plus whatever else we could resolve. */
export interface RawEnsProfile {
  readonly name: string
  readonly records: RawProfileRecords
  readonly address?: `0x${string}` | null
  /** Any read errors encountered. A profile with errors is still returned. */
  readonly errors: readonly string[]
}

export interface ReadProfilesOptions {
  /**
   * Also resolve each name's `addr` record. Costs one extra RPC round-trip per
   * name; useful for display and for de-duplicating one human across names.
   */
  readonly resolveAddress?: boolean
  /**
   * Maximum names read in parallel. Public RPCs commonly rate-limit, so keep this
   * modest (default 4).
   */
  readonly concurrency?: number
  /** Block to read at. Defaults to `latest`. */
  readonly blockNumber?: bigint
}

/** The single seam the index builder depends on. */
export interface ProfileReader {
  /** Read raw text records for a batch of ENS names. */
  readProfiles(names: readonly string[], options?: ReadProfilesOptions): Promise<RawEnsProfile[]>
  /** Read raw text records for one name. */
  readProfile(name: string, options?: ReadProfilesOptions): Promise<RawEnsProfile>
}

/** Convenience: read + parse in one step. */
export async function readCommunityProfiles(
  reader: ProfileReader,
  names: readonly string[],
  options?: ReadProfilesOptions,
): Promise<CommunityProfile[]> {
  const raw = await reader.readProfiles(names, options)
  return raw.map((entry) =>
    parseProfile(entry.name, entry.records, { address: entry.address ?? null }),
  )
}

/** A viem public client. Aliased so consumers can share the type without importing viem. */
export type PublicClient = ViemPublicClient<Transport, Chain>

const KEYS: readonly ProfileRecordKey[] = PROFILE_RECORD_KEY_LIST

/**
 * Live reader. Every value comes from an on-chain `getEnsText` call through the
 * Universal Resolver, so it transparently handles wrapped subnames, DNS names and
 * CCIP-read resolvers.
 */
export class EnsTextProfileReader implements ProfileReader {
  readonly #client: PublicClient
  readonly #concurrency: number

  constructor(client: PublicClient, options: { concurrency?: number } = {}) {
    this.#client = client
    this.#concurrency = options.concurrency ?? 4
  }

  async readProfile(name: string, options: ReadProfilesOptions = {}): Promise<RawEnsProfile> {
    const [result] = await this.readProfiles([name], options)
    if (!result) throw new Error(`Failed to read profile for "${name}"`)
    return result
  }

  async readProfiles(
    names: readonly string[],
    options: ReadProfilesOptions = {},
  ): Promise<RawEnsProfile[]> {
    const concurrency = Math.max(1, options.concurrency ?? this.#concurrency)
    const readOptions = {
      blockNumber: options.blockNumber,
      strict: true,
    } as const

    const readOne = async (rawName: string): Promise<RawEnsProfile> => {
      const name = rawName.trim()
      const records: Record<string, string> = {}
      const errors: string[] = []

      await mapWithConcurrency(KEYS, concurrency, async (key) => {
        try {
          const value = await getEnsText(this.#client, { ...readOptions, name, key })
          if (value !== null && value !== undefined) records[key] = value
        } catch (cause) {
          errors.push(`${key}: ${errorMessage(cause)}`)
        }
      })

      let address: `0x${string}` | null = null
      if (options.resolveAddress) {
        try {
          address = await getEnsAddress(this.#client, {
            ...readOptions,
            name,
          })
        } catch (cause) {
          errors.push(`addr: ${errorMessage(cause)}`)
        }
      }

      return { name, records, address, errors }
    }

    return mapWithConcurrency(names, concurrency, readOne)
  }
}

/**
 * In-memory reader backed by a plain object. This is what the tests use, and it
 * models the chain faithfully: mutate the source object and the next
 * `readProfiles` reflects it, which is exactly how `refresh()` is tested.
 */
export class InMemoryProfileReader implements ProfileReader {
  readonly #source: Map<string, RawProfileRecords>
  /** Number of `readProfiles` calls, so tests can assert refresh() hit the source. */
  readCount = 0

  constructor(source: Record<string, RawProfileRecords> | Map<string, RawProfileRecords>) {
    this.#source = source instanceof Map ? new Map(source) : new Map(Object.entries(source))
  }

  /** Replace one profile's records, simulating someone editing their ENS bio. */
  set(name: string, records: RawProfileRecords): this {
    this.#source.set(name, records)
    return this
  }

  /** Patch one record key for one profile. */
  patch(name: string, key: ProfileRecordKey, value: string | undefined): this {
    const current = { ...(this.#source.get(name) ?? {}) }
    if (value === undefined) delete current[key]
    else current[key] = value
    this.#source.set(name, current)
    return this
  }

  delete(name: string): boolean {
    return this.#source.delete(name)
  }

  has(name: string): boolean {
    return this.#source.has(name)
  }

  names(): string[] {
    return [...this.#source.keys()]
  }

  async readProfile(name: string): Promise<RawEnsProfile> {
    const [result] = await this.readProfiles([name])
    if (!result) throw new Error(`Unknown name "${name}"`)
    return result
  }

  readProfiles(names: readonly string[]): Promise<RawEnsProfile[]> {
    this.readCount += 1
    return Promise.resolve(
      names.map((rawName) => {
        const name = rawName.trim()
        const records = this.#source.get(name)
        return {
          name,
          records: records ? { ...records } : {},
          address: null,
          errors: records ? [] : [`no records for "${name}"`],
        }
      }),
    )
  }
}

export interface CreatePublicClientOptions {
  readonly rpcUrl: string
  /** Defaults to Sepolia; overridable so callers are not locked to one chain. */
  readonly chain?: Chain
  readonly timeout?: number
  readonly retries?: number
}

/** Build a Sepolia public client from an RPC URL. */
export function createPublicClientFromEnv(options: CreatePublicClientOptions): PublicClient {
  return createPublicClient({
    chain: options.chain ?? sepolia,
    transport: httpTransport(options.rpcUrl, {
      timeout: options.timeout ?? 30_000,
      retryCount: options.retries ?? 2,
    }),
  })
}

export function createEnsReader(
  rpcUrl: string,
  options: { concurrency?: number; chain?: Chain } = {},
): EnsTextProfileReader {
  const client = createPublicClientFromEnv({ rpcUrl, chain: options.chain })
  return new EnsTextProfileReader(client, { concurrency: options.concurrency })
}

/** Run `fn` over `items` with bounded parallelism, preserving input order. */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    for (;;) {
      const index = cursor++
      const item = items[index]
      if (index >= items.length || item === undefined) return
      results[index] = await fn(item, index)
    }
  })
  await Promise.all(workers)
  return results
}

function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    const withShort = cause as Error & { shortMessage?: string }
    return withShort.shortMessage ?? cause.message
  }
  return String(cause)
}