/**
 * Build the retrieval index from live ENS profiles and optionally dump it as JSON.
 *
 *   npm run index
 *   npm run index -- --out index.json
 *   npm run index -- --refresh          # rebuild in place, print timing
 *
 * Read-only: it never needs a private key.
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { loadEnvFile, optionalEnv, requireEnv } from '../lib/env.js'
import { DEFAULT_PARENT_NAME, communityNames } from '../lib/community.js'
import { createCommunityIndex } from '../lib/build-index.js'
import { createEnsReader } from '../lib/ens-reader.js'
import { createEmbeddingProvider } from '../lib/embeddings.js'
import { SEPOLIA_CHAIN as sepolia } from '../lib/chain.js'

const USAGE = `Usage: npm run index [--options]

Builds the retrieval index from live ENS profiles. Read-only: no private key.

Options:
  --out=<file>   Also write the index as JSON to <file>
  --refresh      Re-read chain and report timing (default behaviour)
  --help         Show this message

Environment:
  SEPOLIA_RPC_URL        Required. Any Sepolia JSON-RPC endpoint.
  COMMUNITY_PARENT_NAME  Parent 2LD (default: ${DEFAULT_PARENT_NAME})
  EMBEDDING_PROVIDER     Optional: none | hashing | gemini | ollama
`

function parseArgs(argv: readonly string[]): { out: string | null; help: boolean } {
  let out: string | null = null
  let help = false
  for (const arg of argv) {
    if (arg.startsWith('--out=')) out = arg.slice('--out='.length)
    else if (arg === '--help' || arg === '-h') help = true
  }
  return { out, help }
}

async function main(): Promise<void> {
  loadEnvFile()
  const { out, help } = parseArgs(process.argv.slice(2))
  // --help must work without an RPC endpoint.
  if (help) {
    console.log(USAGE)
    return
  }

  const rpcUrl = requireEnv(
    process.env,
    'SEPOLIA_RPC_URL',
    'e.g. https://ethereum-sepolia-rpc.publicnode.com',
  )
  const parentName = optionalEnv(process.env, 'COMMUNITY_PARENT_NAME') ?? DEFAULT_PARENT_NAME
  const names = communityNames(parentName)

  const embeddingProvider = createEmbeddingProvider(process.env)
  const reader = createEnsReader(rpcUrl, { concurrency: 4, chain: sepolia })

  console.log(`\nBuilding index from live ENS profiles`)
  console.log(`  parent    : ${parentName}`)
  console.log(`  names     : ${names.length}`)
  console.log(`  retrieval : ${embeddingProvider ? `hybrid (${embeddingProvider.id})` : 'lexical BM25'}`)

  const startedAt = Date.now()
  const index = await createCommunityIndex({
    reader,
    names,
    embeddingProvider,
    readOptions: { resolveAddress: false, concurrency: 4 },
  })
  const elapsed = Date.now() - startedAt

  console.log(`  indexed   : ${index.size} profiles, ${index.stats.terms} terms in ${elapsed}ms`)
  for (const warning of index.stats.warnings) console.log(`  ! ${warning}`)

  const refreshedAt = Date.now()
  await index.refresh()
  console.log(`  refresh() : re-read ${names.length} profiles in ${Date.now() - refreshedAt}ms`)

  if (out) {
    const path = resolve(process.cwd(), out)
    writeFileSync(path, `${JSON.stringify(index.toJSON(), null, 2)}\n`, 'utf8')
    console.log(`  written   : ${path}`)
  }
  console.log('')
}

main().catch((error: unknown) => {
  console.error(`\nIndex build failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})