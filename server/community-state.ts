/**
 * The server's long-lived view of the community.
 *
 * The index is built once and then rebuilt *in place* by `refresh()`, which is what the
 * "Refresh community index" button in the UI calls. That matters for the demo: edit a
 * profile on Sepolia, hit refresh, and the next answer reflects the edit with no restart.
 *
 * Only this module knows whether the server is reading real chain data or the in-memory
 * fixtures, and it reports that provenance so the UI can display it honestly instead of
 * implying a live read that did not happen.
 */

import { createCommunityIndex, type CommunityIndex, type IndexStats } from '../lib/build-index.js'
import { communityNames, DEFAULT_PARENT_NAME, fixtureProfileMap } from '../lib/community.js'
import { createEmbeddingProvider, type EmbeddingProvider } from '../lib/embeddings.js'
import { createEnsReader, InMemoryProfileReader, type ProfileReader } from '../lib/ens-reader.js'
import { SEPOLIA_CHAIN as sepolia } from '../lib/chain.js'

export type DataSource = 'chain' | 'fixtures'

export interface CommunityStateOptions {
  /** Roster to index. Defaults to the nine fixture subnames under the parent. */
  readonly names?: readonly string[]
  /** Use the in-memory fixtures instead of reading Sepolia. */
  readonly useFixtures?: boolean
  /** Parent the fixtures are rendered under. */
  readonly fixtureParent?: string
  readonly rpcUrl?: string
  /** Overrides the env-derived provider. `null` forces lexical-only. */
  readonly embeddingProvider?: EmbeddingProvider | null
  readonly embeddingEnv?: Record<string, string | undefined>
}

export interface CommunityStatus {
  readonly source: DataSource
  readonly parentName: string
  readonly names: readonly string[]
  readonly stats: IndexStats
  readonly embeddingProvider: string | null
  /** ISO timestamp of the last completed build or refresh. */
  readonly builtAt: string
  /** True when a chain-backed index holds zero readable profiles. */
  readonly degraded: boolean
  readonly warnings: readonly string[]
}

/**
 * Wraps the index with the state the HTTP layer needs.
 *
 * `refresh()` serialises concurrent callers onto one rebuild: two simultaneous button
 * presses must not race two chain sweeps into the same index.
 */
export class CommunityState {
  #index: CommunityIndex
  readonly #names: readonly string[]
  readonly #source: DataSource
  readonly #parentName: string
  #builtAt = new Date()
  #degraded = false
  #warnings: readonly string[] = []
  #inFlight: Promise<void> | null = null

  private constructor(init: {
    index: CommunityIndex
    names: readonly string[]
    source: DataSource
    parentName: string
  }) {
    this.#index = init.index
    this.#names = init.names
    this.#source = init.source
    this.#parentName = init.parentName
  }

  static async create(options: CommunityStateOptions = {}): Promise<CommunityState> {
    // Honour the configured parent in both modes, so a fixture-backed demo shows the
    // same ENS names a chain-backed run would — otherwise the recorded artefacts would
    // disagree with the roster in the README.
    const parentName =
      options.fixtureParent ?? process.env.COMMUNITY_PARENT_NAME ?? DEFAULT_PARENT_NAME
    const names = options.names ?? communityNames(parentName)
    const useFixtures = options.useFixtures === true

    const reader: ProfileReader = useFixtures
      ? new InMemoryProfileReader(fixtureProfileMap(parentName))
      : createEnsReader(requireRpcUrl(options.rpcUrl), { concurrency: 4, chain: sepolia })

    const embeddingProvider =
      options.embeddingProvider !== undefined
        ? options.embeddingProvider
        : createEmbeddingProvider(options.embeddingEnv ?? process.env)

    const index = await createCommunityIndex({
      reader,
      names,
      embeddingProvider,
      onWarning: (message) => console.warn(`[index] ${message}`),
    })

    const state = new CommunityState({
      index,
      names,
      source: useFixtures ? 'fixtures' : 'chain',
      parentName,
    })
    state.#warnings = [...index.stats.warnings]
    state.#degraded = !useFixtures && index.stats.documents === 0
    return state
  }

  get index(): CommunityIndex {
    return this.#index
  }

  get status(): CommunityStatus {
    return {
      source: this.#source,
      parentName: this.#parentName,
      names: this.#names,
      stats: this.#index.stats,
      embeddingProvider: this.#index.stats.embeddingProvider,
      builtAt: this.#builtAt.toISOString(),
      degraded: this.#degraded,
      warnings: this.#warnings,
    }
  }

  /**
   * Re-reads the roster and rebuilds in place.
   *
   * Concurrent callers share one rebuild rather than each starting their own.
   */
  async refresh(): Promise<CommunityStatus> {
    this.#inFlight ??= this.#doRefresh().finally(() => {
      this.#inFlight = null
    })
    await this.#inFlight
    return this.status
  }

  async #doRefresh(): Promise<void> {
    const startedAt = Date.now()
    await this.#index.refresh()
    this.#builtAt = new Date()
    this.#warnings = [...this.#index.stats.warnings]
    // Zero readable profiles on a chain-backed index means the read failed, not that the
    // community is empty. The UI shows that as degraded rather than as "no results".
    this.#degraded = this.#source === 'chain' && this.#index.stats.documents === 0
    console.log(`[index] refreshed ${this.#index.stats.documents} profiles in ${Date.now() - startedAt}ms`)
  }
}

function requireRpcUrl(explicit: string | undefined): string {
  const rpcUrl = explicit ?? process.env.SEPOLIA_RPC_URL
  if (typeof rpcUrl !== 'string' || rpcUrl.trim() === '')
    throw new Error(
      'SEPOLIA_RPC_URL is not set. Add it to .env, or run the server with USE_FIXTURES=1 for an offline demo.',
    )
  return rpcUrl
}
