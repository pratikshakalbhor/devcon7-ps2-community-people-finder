/**
 * Query the community index from the command line.
 *
 *   npm run query -- "rust mentor"
 *   npm run query -- "solidity audit" --limit=3 --availability=available
 *   npm run query -- "embedded" --json
 *   npm run query -- --help
 *
 * Read-only. Builds the index from chain, ranks, prints, exits.
 */

const USAGE = `Usage: npm run query -- "<query>" [options]

Options:
  --limit=<n>              Max results to print (default 5)
  --no-penalty             Audit mode: rank as if the prompt-injection penalty
                           were disabled, to see what a hostile profile would
                           otherwise get
  --availability=<list>    Comma-separated filter: available, limited,
                           unavailable, unknown
  --json                   Machine-readable output
  --help                   Show this message

Environment:
  SEPOLIA_RPC_URL          Required. Any Sepolia JSON-RPC endpoint.
  COMMUNITY_PARENT_NAME    Parent 2LD. Defaults to ${DEFAULT_PARENT_NAME}.
  EMBEDDING_PROVIDER       Optional: none | hashing | gemini | ollama
`
import { loadEnvFile, optionalEnv, requireEnv } from '../lib/env.js'
import { DEFAULT_PARENT_NAME, communityNames } from '../lib/community.js'
import { createCommunityIndex } from '../lib/build-index.js'
import { createEnsReader } from '../lib/ens-reader.js'
import { createEmbeddingProvider } from '../lib/embeddings.js'
import { AVAILABILITY_VALUES, type ProfileAvailability } from '../lib/profile-schema.js'
import { SEPOLIA_CHAIN as sepolia } from '../lib/chain.js'

function parseArgs(argv: readonly string[]): {
  query: string
  limit: number
  availability: ProfileAvailability[]
  json: boolean
  help: boolean
  penaliseInjection: boolean
} {
  const positional: string[] = []
  let limit = 5
  let availability: ProfileAvailability[] = []
  let json = false
  let help = false
  const penaliseInjection = argv.includes('--no-penalty') || argv.includes('--no-penalise-injection') ? false : true
  for (const arg of argv) {
    if (arg.startsWith('--limit=')) limit = Number(arg.slice('--limit='.length))
    else if (arg.startsWith('--availability=')) {
      availability = arg
        .slice('--availability='.length)
        .split(',')
        .map((value) => value.trim().toLowerCase())
        .filter((value): value is ProfileAvailability =>
          (['available', 'limited', 'unavailable', 'unknown'] as string[]).includes(value),
        )
    } else if (arg === '--json') json = true
    else if (arg === '--help' || arg === '-h') help = true
    else positional.push(arg)
  }
  return { query: positional.join(' ').trim(), limit, availability, json, help, penaliseInjection }
}

async function main(): Promise<void> {
  loadEnvFile()
  const options = parseArgs(process.argv.slice(2))
  // --help must work without a wallet or an RPC endpoint.
  if (options.help) {
    console.log(USAGE)
    return
  }
  if (options.query === '') {
    throw new Error('Missing query.\n\n' + USAGE)
  }

  const rpcUrl = requireEnv(process.env, 'SEPOLIA_RPC_URL', 'e.g. https://ethereum-sepolia-rpc.publicnode.com')
  const parentName = optionalEnv(process.env, 'COMMUNITY_PARENT_NAME') ?? DEFAULT_PARENT_NAME
  const embeddingProvider = createEmbeddingProvider(process.env)

  const index = await createCommunityIndex({
    reader: createEnsReader(rpcUrl, { concurrency: 4, chain: sepolia }),
    names: communityNames(parentName),
    embeddingProvider,
    penaliseSuspectedInjection: options.penaliseInjection,
  })

  const results = await index.query(options.query, {
    limit: options.limit,
    ...(options.availability.length > 0 ? { availability: options.availability } : {}),
  })

  if (options.json) {
    console.log(
      JSON.stringify(
        results.map((result) => ({
          name: result.name,
          score: Number(result.score.toFixed(4)),
          lexicalScore: Number(result.lexicalScore.toFixed(4)),
          embeddingScore: result.embeddingScore === null ? null : Number(result.embeddingScore.toFixed(4)),
          availability: result.availability,
          matchedSkills: result.matchedSkills,
          injectionSuspected: result.injectionSuspected,
          bio: result.profile.bio,
        })),
        null,
        2,
      ),
    )
    return
  }

  console.log(`\n"${options.query}" — ${results.length} result(s) from ${index.size} profiles\n`)
  results.forEach((result, i) => {
    const flag = result.injectionSuspected ? '  [injection-suspected, demoted]' : ''
    console.log(`  ${i + 1}. ${result.name}  score ${result.score.toFixed(3)}${flag}`)
    console.log(`     skills    : ${result.profile.skills.join(', ') || '(none)'}`)
    console.log(`     available : ${result.availability}`)
    console.log(`     matched   : ${result.matchedSkills.join(', ') || result.matchedTerms.join(', ') || '-'}`)
    console.log(`     bio       : ${result.profile.bio || '(none)'}`)
    console.log('')
  })
  if (results.length === 0) {
    console.log(`  No matches. Availability tiers are ${AVAILABILITY_VALUES.join(' / ')}.\n`)
  }
}

main().catch((error: unknown) => {
  console.error(`\nQuery failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})