/**
 * Seed the community's ENS profiles on Sepolia.
 *
 *   npm run seed                 # real run
 *   npm run seed -- --dry-run    # print the plan, touch nothing
 *   npm run seed -- --parent=yourname.eth --only=alice,heidi
 *
 * Per member:
 *   1. Create `<label>.<parent>` — via NameWrapper.setSubnodeRecord when the parent
 *      is wrapped, or registry.setSubnodeOwner + setResolver when it is not. Subnames
 *      cost gas only; there is no registration premium.
 *   2. Write the profile text records (+ an `addr` record) in one resolver multicall.
 *
 * The Sepolia Public Resolver resolves `ens.owner(node) == nameWrapper` down to the
 * wrapper's NFT owner, so a plain EOA can write records on its own wrapped subnames
 * without deploying a subname-registrar contract.
 *
 * The script is idempotent: existing names are reused and only records are rewritten,
 * so re-running after editing a bio is the intended way to change a profile.
 */
import {
  createWalletClient,
  encodeFunctionData,
  formatEther,
  http as httpTransport,
  namehash,
  type Address,
  type Hex,
} from 'viem'
import { getEnsAddress, getEnsResolver } from 'viem/actions'
import { privateKeyToAccount } from 'viem/accounts'
import { loadEnvFile, requireEnv } from '../lib/env.js'
import { COMMUNITY_FIXTURES, DEFAULT_PARENT_NAME, fixtureRecords } from '../lib/community.js'
import {
  ENS_ADDRESSES,
  ZERO_ADDRESS,
  describeFuses,
  ensRegistryAbi,
  nameWrapperAbi,
  resolverAbi,
} from '../lib/ens-contracts.js'
import { createPublicClientFromEnv, type PublicClient } from '../lib/ens-reader.js'
import { PROFILE_RECORD_KEYS } from '../lib/profile-schema.js'
import { SEPOLIA_CHAIN as sepolia } from '../lib/chain.js'

const SEPOLIA_CHAIN_ID = 11155111

interface CliOptions {
  readonly parentName: string
  readonly dryRun: boolean
  readonly only: string[] | null
}

function parseArgs(argv: readonly string[]): CliOptions {
  let parentName = process.env.COMMUNITY_PARENT_NAME ?? DEFAULT_PARENT_NAME
  let dryRun = process.env.SEED_DRY_RUN === '1'
  const only: string[] = []
  for (const arg of argv) {
    if (arg.startsWith('--parent=')) parentName = arg.slice('--parent='.length)
    else if (arg === '--dry-run') dryRun = true
    else if (arg.startsWith('--only=')) only.push(...arg.slice('--only='.length).split(','))
  }
  return {
    parentName: parentName.trim().replace(/\.$/, ''),
    dryRun,
    only: only.length > 0 ? only.map((value) => value.trim()).filter(Boolean) : null,
  }
}

/** How the parent is held, which decides how subnames get created. */
type ParentMode = 'wrapped' | 'unwrapped' | 'ensv2' | 'unavailable'

interface ParentState {
  readonly mode: ParentMode
  readonly registryOwner: Address
  readonly wrapperOwner: Address | null
  readonly canCreateSubnames: boolean
  readonly expiry: bigint
  readonly detail: string
}

/**
 * Works out whether the deployer can create subnames under `parentName`.
 *
 * The legacy registry's `owner()` is authoritative only for names registered in that
 * registry. Since the ENSv2 deployment on Sepolia, a real 2LD returns the zero address
 * there, so trusting that read alone makes a registered parent look nonexistent and
 * blocks seeding with "does not exist on Sepolia".
 *
 * So the legacy read is taken as authoritative when it is non-zero, and the Universal
 * Resolver is consulted when it is not. In the latter case ownership cannot be proven
 * from a public read, so the mode becomes `ensv2`: we report what we could verify and let
 * the transaction itself be the authority. A revert from the chain is a far better error
 * message than a guess made before sending anything.
 */
async function inspectParent(client: PublicClient, parentName: string): Promise<ParentState> {
  const parentNode = namehash(parentName)
  const registryOwner = await client.readContract({
    address: ENS_ADDRESSES.registry.address,
    abi: ensRegistryAbi,
    functionName: 'owner',
    args: [parentNode],
  })
  const resolver = await client.readContract({
    address: ENS_ADDRESSES.registry.address,
    abi: ensRegistryAbi,
    functionName: 'resolver',
    args: [parentNode],
  })

  if (registryOwner === ZERO_ADDRESS) {
    // Fall back to the Universal Resolver, which does understand ENSv2 names.
    let urResolver: Address | null = null
    let urAddress: Address | null = null
    try {
      urResolver = await getEnsResolver(client, { name: parentName })
      urAddress = await getEnsAddress(client, { name: parentName })
    } catch {
      // Leave both null; reported as unavailable below.
    }

    if (urResolver !== null && urResolver !== ZERO_ADDRESS) {
      return {
        mode: 'ensv2',
        registryOwner,
        wrapperOwner: null,
        canCreateSubnames: true,
        expiry: 0n,
        detail:
          `"${parentName}" resolves via the Universal Resolver (resolver ${urResolver}` +
          `${urAddress && urAddress !== ZERO_ADDRESS ? `, address ${urAddress}` : ''}) but has no ` +
          'owner in the legacy registry — consistent with an ENSv2 registration. Ownership ' +
          'cannot be proven from a public read, so the write itself will confirm it.',
      }
    }

    return {
      mode: 'unavailable',
      registryOwner,
      wrapperOwner: null,
      canCreateSubnames: false,
      expiry: 0n,
      detail: `"${parentName}" does not exist on Sepolia (no legacy registry owner and no Universal Resolver entry)`,
    }
  }

  if (registryOwner === ENS_ADDRESSES.nameWrapper.address) {
    const [wrapperOwner, fuses, expiry] = await client.readContract({
      address: ENS_ADDRESSES.nameWrapper.address,
      abi: nameWrapperAbi,
      functionName: 'getData',
      args: [BigInt(parentNode)],
    })
    const canCreateSubnames = await client.readContract({
      address: ENS_ADDRESSES.nameWrapper.address,
      abi: nameWrapperAbi,
      functionName: 'canModifyName',
      args: [parentNode, wrapperOwner],
    })
    return {
      mode: 'wrapped',
      registryOwner,
      wrapperOwner,
      canCreateSubnames,
      expiry,
      detail: `wrapped by ${wrapperOwner}, resolver ${resolver}, fuses: ${describeFuses(fuses)}`,
    }
  }

  return {
    mode: 'unwrapped',
    registryOwner,
    wrapperOwner: null,
    canCreateSubnames: true,
    expiry: 0n,
    detail: `owned directly in the registry by ${registryOwner}, resolver ${resolver}`,
  }
}

function assertDeployerControlsParent(parent: ParentState, deployer: Address): void {
  const controls =
    parent.mode === 'wrapped'
      ? parent.canCreateSubnames && parent.wrapperOwner === deployer
      : parent.mode === 'ensv2'
        ? true // unverifiable from a public read; the transaction is the authority
        : parent.registryOwner === deployer
  if (controls) return

  const reason =
    parent.mode === 'wrapped'
      ? parent.canCreateSubnames
        ? `its NameWrapper owner is ${parent.wrapperOwner}, not ${deployer}`
        : `its PARENT_CANNOT_CONTROL / CANNOT_CREATE_SUBDOMAIN fuse is burned, so subnames cannot be created`
      : `its registry owner is ${parent.registryOwner}, not ${deployer}`

  throw new Error(
    [`${deployer} cannot create subnames under this parent: ${reason}.`, ''].join('\n'),
  )
}

function recordCallsFor(node: Hex, records: Record<string, string>, owner: Address): Hex[] {
  return [
    ...Object.entries(records).map(([key, value]) =>
      encodeFunctionData({
        abi: resolverAbi,
        functionName: 'setText',
        args: [node, key, value],
      }),
    ),
    encodeFunctionData({ abi: resolverAbi, functionName: 'setAddr', args: [node, owner] }),
  ]
}

function printDryRun(options: CliOptions, fixtures: typeof COMMUNITY_FIXTURES): void {
  console.log('\n  DRY RUN — no wallet, no transactions.\n')
  for (const fixture of fixtures) {
    const name = `${fixture.label}.${options.parentName}`
    const records = fixtureRecords(fixture)
    console.log(`  ${name}`)
    console.log(`    ${PROFILE_RECORD_KEYS.skills.padEnd(32)} = ${records[PROFILE_RECORD_KEYS.skills]}`)
    console.log(
      `    ${PROFILE_RECORD_KEYS.availability.padEnd(32)} = ${records[PROFILE_RECORD_KEYS.availability]}`,
    )
    console.log(`    ${PROFILE_RECORD_KEYS.bio.padEnd(32)} = ${records[PROFILE_RECORD_KEYS.bio]}`)
    if (fixture.note) console.log(`    note: ${fixture.note}`)
    console.log('')
  }
  console.log(`  Would create/refresh ${fixtures.length} profiles under ${options.parentName}.\n`)
}

const MISSING_PARENT_HELP = [
  'How to get a parent name on Sepolia:',
  '  1. Mint one at https://app.ens.domains/testnet (testnet mode), or',
  '  2. Reuse any Sepolia name whose owner is the address of PRIVATE_KEY.',
  '',
  'Then set COMMUNITY_PARENT_NAME=<yourname>.eth in .env (or pass --parent=).',
  'Subnames are created by the NameWrapper, so no registration premium is paid —',
  'only gas.',
].join('\n')

async function main(): Promise<void> {
  loadEnvFile()
  const options = parseArgs(process.argv.slice(2))

  const rpcUrl = requireEnv(
    process.env,
    'SEPOLIA_RPC_URL',
    'e.g. https://ethereum-sepolia-rpc.publicnode.com',
  )
  const publicClient = createPublicClientFromEnv({ rpcUrl, chain: sepolia })

  const chainId = await publicClient.getChainId()
  if (chainId !== SEPOLIA_CHAIN_ID) {
    throw new Error(
      `Refusing to seed: the RPC reports chain id ${chainId}, expected Sepolia (${SEPOLIA_CHAIN_ID}).`,
    )
  }

  const fixtures = options.only
    ? COMMUNITY_FIXTURES.filter((fixture) => options.only?.includes(fixture.label))
    : COMMUNITY_FIXTURES
  if (fixtures.length === 0) {
    throw new Error(
      `--only matched nothing. Available labels: ${COMMUNITY_FIXTURES.map((f) => f.label).join(', ')}`,
    )
  }

  console.log('\nENS community seeder — Sepolia')
  console.log(`  rpc       : ${redactUrl(rpcUrl)}`)
  console.log(`  parent    : ${options.parentName}`)
  console.log(`  members   : ${fixtures.length}`)
  console.log(`  resolver  : ${ENS_ADDRESSES.publicResolver.address}`)

  const parent = await inspectParent(publicClient, options.parentName)
  console.log(`  parent    : ${parent.detail}`)

  if (parent.mode === 'unavailable') {
    throw new Error([parent.detail, '', MISSING_PARENT_HELP].join('\n'))
  }

  if (options.dryRun) {
    printDryRun(options, fixtures)
    return
  }

  const privateKey = requireEnv(
    process.env,
    'PRIVATE_KEY',
    `Deployer key; must control ${options.parentName}.`,
  )
  const account = privateKeyToAccount(privateKey as Hex)
  assertDeployerControlsParent(parent, account.address)
  console.log(`  deployer  : ${account.address}`)

  const balance = await publicClient.getBalance({ address: account.address })
  if (balance === 0n) {
    throw new Error(
      `${account.address} has 0 ETH on Sepolia. Faucet: https://sepoliafaucet.com (or any Sepolia faucet).`,
    )
  }
  console.log(`  balance   : ${formatEther(balance)} ETH`)

  const walletClient = createWalletClient({
    account,
    chain: sepolia,
    transport: httpTransport(rpcUrl),
  })

  const parentNode = namehash(options.parentName)
  const resolverAddress = ENS_ADDRESSES.publicResolver.address
  let createdCount = 0

  for (const fixture of fixtures) {
    const name = `${fixture.label}.${options.parentName}`
    const node = namehash(name)
    const records = fixtureRecords(fixture)

    const exists = await publicClient.readContract({
      address: ENS_ADDRESSES.registry.address,
      abi: ensRegistryAbi,
      functionName: 'recordExists',
      args: [node],
    })

    if (!exists) {
      createdCount += 1
      if (parent.mode === 'wrapped') {
        console.log(`  ${name}: creating wrapped subname`)
        const hash = await walletClient.writeContract({
          address: ENS_ADDRESSES.nameWrapper.address,
          abi: nameWrapperAbi,
          functionName: 'setSubnodeRecord',
          // args: parentNode, label, owner, resolver, ttl (uint64), fuses (uint32), expiry (uint64)
          args: [parentNode, fixture.label, account.address, resolverAddress, 0n, 0, parent.expiry],
          chain: sepolia,
          account,
        })
        await publicClient.waitForTransactionReceipt({ hash })
        console.log(`      tx ${hash}`)
      } else {
        console.log(`  ${name}: creating registry subname`)
        // namehash('alice') === labelhash('alice') for a single label.
        const ownerHash = await walletClient.writeContract({
          address: ENS_ADDRESSES.registry.address,
          abi: ensRegistryAbi,
          functionName: 'setSubnodeOwner',
          args: [parentNode, namehash(fixture.label), account.address],
          chain: sepolia,
          account,
        })
        await publicClient.waitForTransactionReceipt({ hash: ownerHash })
        const resolverHash = await walletClient.writeContract({
          address: ENS_ADDRESSES.registry.address,
          abi: ensRegistryAbi,
          functionName: 'setResolver',
          args: [node, resolverAddress],
          chain: sepolia,
          account,
        })
        await publicClient.waitForTransactionReceipt({ hash: resolverHash })
        console.log(`      tx ${ownerHash}`)
        console.log(`      tx ${resolverHash}`)
      }
    } else {
      const currentResolver = await publicClient.readContract({
        address: ENS_ADDRESSES.registry.address,
        abi: ensRegistryAbi,
        functionName: 'resolver',
        args: [node],
      })
      if (currentResolver === ZERO_ADDRESS) {
        const resolverHash = await walletClient.writeContract({
          address: ENS_ADDRESSES.registry.address,
          abi: ensRegistryAbi,
          functionName: 'setResolver',
          args: [node, resolverAddress],
          chain: sepolia,
          account,
        })
        await publicClient.waitForTransactionReceipt({ hash: resolverHash })
        console.log(`  ${name}: resolver set (tx ${resolverHash})`)
      } else {
        console.log(`  ${name}: exists, refreshing records`)
      }
    }

    const calls = recordCallsFor(node, records, account.address)
    const hash = await walletClient.writeContract({
      address: resolverAddress,
      abi: resolverAbi,
      functionName: 'multicall',
      args: [calls],
      chain: sepolia,
      account,
    })
    await publicClient.waitForTransactionReceipt({ hash })
    console.log(`      ${calls.length} records written (tx ${hash})`)
    if (fixture.adversarial) {
      console.log(`      (prompt-injection fixture — the verifier should flag this bio)`)
    }
  }

  console.log(
    `\n  Done. ${fixtures.length} profiles live under ${options.parentName} (${createdCount} newly created).`,
  )
  console.log(`  Verify:  npm run verify`)
  console.log(`  Index:   npm run index -- --out index.json`)
  console.log(`  Query:   npm run query -- "rust mentor"\n`)
}

function redactUrl(url: string): string {
  try {
    const parsed = new URL(url)
    for (const param of ['key', 'apikey', 'api_key']) {
      if (parsed.searchParams.has(param)) parsed.searchParams.set(param, '***')
    }
    return parsed.toString()
  } catch {
    return url
  }
}

main().catch((error: unknown) => {
  console.error(`\nSeed failed: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})