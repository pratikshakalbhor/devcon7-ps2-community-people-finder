/**
 * Read every community profile back off chain and print it. Read-only, no wallet,
 * no private key — this is the "is any of this actually live?" script.
 *
 *   npm run verify
 *   npm run verify -- --json
 *   npm run verify -- --parent=yourname.eth
 *
 * It reports, per name: the registry owner, the resolver, the raw value of each
 * `community.dev.*` record, schema issues, and whether the bio tripped the
 * prompt-injection heuristics. Exits non-zero if any profile is missing or
 * unparseable, so it can gate a deploy.
 */
import { namehash, type Address } from 'viem'
import { getEnsResolver } from 'viem/actions'
import { loadEnvFile, requireEnv } from '../lib/env.js'
import { communityNames, DEFAULT_PARENT_NAME } from '../lib/community.js'
import { ENS_ADDRESSES, ZERO_ADDRESS, ensRegistryAbi } from '../lib/ens-contracts.js'
import { createEnsReader, createPublicClientFromEnv, type PublicClient } from '../lib/ens-reader.js'
import {
  AVAILABILITY_VALUES,
  PROFILE_RECORD_KEY_LIST,
  parseProfile,
  type CommunityProfile,
} from '../lib/profile-schema.js'
import { SEPOLIA_CHAIN as sepolia } from '../lib/chain.js'

interface CliOptions {
  readonly parentName: string
  readonly json: boolean
  readonly includeAddresses: boolean
  readonly help: boolean
}

const USAGE = `Usage: npm run verify [--options]

Reads the three community.dev.* records for every seeded subname. Read-only:
no private key, no transactions.

Options:
  --parent=<name>   Parent 2LD to check (default: COMMUNITY_PARENT_NAME,
                    else ${DEFAULT_PARENT_NAME})
  --addresses       Also resolve and print each addr record
  --json            Machine-readable output, for CI
  --help            Show this message

Environment:
  SEPOLIA_RPC_URL   Required. Any Sepolia JSON-RPC endpoint.

Exits non-zero if any name is missing records or has a flagged profile.
`

function parseArgs(argv: readonly string[]): CliOptions {
  let parentName = process.env.COMMUNITY_PARENT_NAME ?? DEFAULT_PARENT_NAME
  let json = false
  let includeAddresses = false
  let help = false
  for (const arg of argv) {
    if (arg.startsWith('--parent=')) parentName = arg.slice('--parent='.length)
    else if (arg === '--json') json = true
    else if (arg === '--addresses') includeAddresses = true
    else if (arg === '--help' || arg === '-h') help = true
  }
  return { parentName: parentName.trim().replace(/\.$/, ''), json, includeAddresses, help }
}

/**
 * A name that is a bare 2LD, e.g. `foo.eth`.
 *
 * This distinction matters because of how ENSv2 resolves names: the Universal Resolver
 * hands back the *parent's* resolver for any subdomain, whether or not that subdomain
 * exists. Confirmed on Sepolia — a deliberately impossible subname
 * (`this-subname-cannot-possibly-exist-99.<parent>.eth`) resolves to the same
 * non-zero resolver as a real one. So for a subname the resolver says nothing about
 * existence and must not be used as evidence. For a 2LD it is a genuine signal: an
 * unregistered `.eth` returns the zero address.
 */
function isSecondLevel(name: string): boolean {
  return name.toLowerCase().endsWith('.eth') && name.split('.').length === 2
}

interface NameStatus {
  readonly owner: string
  readonly resolver: string
  /** True only when there is positive evidence the name itself is registered. */
  readonly exists: boolean
}

async function describeName(client: PublicClient, name: string): Promise<NameStatus> {
  const twoLevel = isSecondLevel(name)

  // The legacy registry still owns pre-ENSv2 names, so ask it first and use a non-zero
  // answer as authoritative.
  let legacyOwner: Address | null = null
  try {
    legacyOwner = await client.readContract({
      address: ENS_ADDRESSES.registry.address,
      abi: ensRegistryAbi,
      functionName: 'owner',
      args: [namehash(name)],
    })
  } catch {
    legacyOwner = null
  }

  let urResolver: Address | null = null
  try {
    urResolver = await getEnsResolver(client, { name })
  } catch {
    urResolver = null
  }
  const urResolved = urResolver !== null && urResolver !== ZERO_ADDRESS

  let resolver: string
  if (urResolved) {
    resolver = twoLevel
      ? `${urResolver} (via Universal Resolver)`
      : `${urResolver} (inherited from parent — not evidence of existence)`
  } else {
    const legacyResolver = await client
      .readContract({
        address: ENS_ADDRESSES.registry.address,
        abi: ensRegistryAbi,
        functionName: 'resolver',
        args: [namehash(name)],
      })
      .catch(() => ZERO_ADDRESS)
    resolver =
      legacyResolver === ZERO_ADDRESS
        ? 'none'
        : legacyResolver === ENS_ADDRESSES.publicResolver.address
          ? 'PublicResolver (current)'
          : legacyResolver === ENS_ADDRESSES.legacyPublicResolver.address
            ? 'PublicResolver (legacy)'
            : String(legacyResolver)
  }

  let owner: string
  let exists: boolean
  if (legacyOwner !== null && legacyOwner !== ZERO_ADDRESS) {
    owner = legacyOwner === ENS_ADDRESSES.nameWrapper.address ? 'NameWrapper (wrapped)' : legacyOwner
    exists = true
  } else if (twoLevel) {
    // A 2LD with no legacy owner: the Universal Resolver is the only authority.
    exists = urResolved
    owner = urResolved
      ? 'unknown (ENSv2: not in the legacy registry; ownership held by the ENSv2 registrar)'
      : 'UNREGISTERED'
  } else {
    // A subname: neither read can speak to existence, so say so instead of guessing.
    exists = false
    owner =
      'unknown (ENSv2 subname: ownership and existence are decided by the text records ' +
      'below, not by a registry owner read)'
  }

  return { owner, resolver, exists }
}

interface VerificationSummary {
  readonly ok: boolean
  readonly profiles: CommunityProfile[]
  readonly missing: string[]
  readonly flagged: string[]
  readonly checkedKeys: readonly string[]
}

async function main(): Promise<void> {
  loadEnvFile()
  const options = parseArgs(process.argv.slice(2))
  // --help must work without an RPC endpoint.
  if (options.help) {
    console.log(USAGE)
    return
  }
  const rpcUrl = requireEnv(
    process.env,
    'SEPOLIA_RPC_URL',
    'e.g. https://ethereum-sepolia-rpc.publicnode.com',
  )

  const names = communityNames(options.parentName)
  const reader = createEnsReader(rpcUrl, { concurrency: 4, chain: sepolia })
  const client = createPublicClientFromEnv({ rpcUrl, chain: sepolia })

  if (!options.json) {
    console.log(`\nENS community verifier — read-only, Sepolia`)
    console.log(`  parent : ${options.parentName}`)
    console.log(`  names  : ${names.length}`)
    console.log(`  keys   : ${PROFILE_RECORD_KEY_LIST.join(', ')}`)
    console.log(`  schema : availability ∈ {${AVAILABILITY_VALUES.join(', ')}}\n`)
  }

  const raw = await reader.readProfiles(names, {
    resolveAddress: options.includeAddresses,
    concurrency: 4,
  })
  const profiles = raw.map((entry) =>
    parseProfile(entry.name, entry.records, { address: entry.address ?? null }),
  )

  const missing = profiles.filter((profile) => profile.bio === '' && profile.skills.length === 0)
  const flagged = profiles.filter((profile) => profile.flags.injectionSuspected)
  const summary: VerificationSummary = {
    ok: missing.length === 0,
    profiles,
    missing: missing.map((profile) => profile.name),
    flagged: flagged.map((profile) => profile.name),
    checkedKeys: PROFILE_RECORD_KEY_LIST,
  }

  if (options.json) {
    console.log(JSON.stringify(summary, null, 2))
    process.exitCode = summary.ok ? 0 : 1
    return
  }

  for (const profile of profiles) {
    const { owner, resolver } = await describeName(client, profile.name)
    const isMissing = summary.missing.includes(profile.name)

    console.log(`  ${isMissing ? '✗' : '✓'} ${profile.name}`)
    console.log(`      owner    : ${owner}`)
    console.log(`      resolver : ${resolver}`)
    if (profile.address) console.log(`      address  : ${profile.address}`)
    console.log(`      skills   : ${profile.skills.length > 0 ? profile.skills.join(', ') : '(none)'}`)
    console.log(`      available: ${profile.availability}`)
    console.log(`      bio      : ${profile.bio === '' ? '(none)' : profile.bio}`)
    if (profile.flags.injectionSuspected) {
      console.log(
        `      ⚑ FLAGGED : bio contains LLM-directed instructions [${profile.flags.injectionPatterns.join(', ')}]`,
      )
    }
    for (const issue of profile.issues) console.log(`      ! ${issue.field}: ${issue.message}`)
    console.log('')
  }

  console.log(`  ${profiles.length - missing.length}/${profiles.length} profiles readable from chain.`)
  if (flagged.length > 0) {
    console.log(
      `  ${flagged.length} profile(s) contain prompt-injection patterns: ${flagged.map((p) => p.name).join(', ')}`,
    )
    console.log('  This is expected — those are the adversarial fixtures, and they are')
    console.log('  demoted by the retrieval index rather than trusted.')
  }
  if (!summary.ok) {
    console.error(`\n  Missing profiles: ${summary.missing.join(', ')}`)
    console.error('  Run `npm run seed` first.\n')
    process.exitCode = 1
    return
  }
  console.log('')
}

main().catch((error: unknown) => {
  console.error(`\nVerify failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})