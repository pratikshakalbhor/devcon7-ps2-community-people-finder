/**
 * Minimal ENS read probe. Deliberately standalone and dependency-light: it exists to
 * answer "is this a resolution failure or a text-record failure?", nothing else.
 *
 *   node scripts/debug-ens-read.mjs [name]
 */
import { createPublicClient, http } from 'viem'
import { normalize, namehash } from 'viem/ens'
import { getEnsText, getEnsAddress, getEnsResolver } from 'viem/actions'
import { sepolia } from 'viem/chains'

const NAME = process.argv[2] ?? 'kenji-community-pk2026.eth'
const KEY = 'community.dev.bio'

const RPCS = [
  ['publicnode (in use today)', 'https://ethereum-sepolia-rpc.publicnode.com'],
  ['rpc.sepolia.org', 'https://rpc.sepolia.org'],
  ['drpc', 'https://sepolia.drpc.org'],
  ['1rpc', 'https://1rpc.io/sepolia'],
  ['blast', 'https://eth-sepolia.public.blastapi.io'],
]

const LEGACY_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'
const ZERO = '0x0000000000000000000000000000000000000000'

const short = (v) => (typeof v === 'string' && v.length > 42 ? `${v.slice(0, 10)}…${v.slice(-8)}` : v)

async function tryIt(label, fn) {
  try {
    const value = await fn()
    console.log(`    ${label.padEnd(26)} ${short(String(value))}`)
    return value
  } catch (error) {
    const msg = String(error?.shortMessage ?? error?.message ?? error).split('\n')[0]
    console.log(`    ${label.padEnd(26)} THREW  ${msg}`)
    return Symbol.for('threw')
  }
}

console.log(`name        : ${NAME}`)
console.log(`key         : ${KEY}`)
console.log(`normalize() : ${normalize(NAME)}`)
console.log(`namehash    : ${namehash(NAME)}`)
console.log()

for (const [label, url] of RPCS) {
  console.log(`== ${label}`)
  console.log(`   ${url}`)
  const client = createPublicClient({ chain: sepolia, transport: http(url, { timeout: 20_000 }) })

  try {
    const cid = await client.getChainId()
    console.log(`    ${'chainId'.padEnd(26)} ${cid} ${cid === 11155111 ? '' : '  <-- WRONG CHAIN'}`)
  } catch (error) {
    console.log(`    ${'chainId'.padEnd(26)} RPC UNREACHABLE  ${String(error?.shortMessage ?? error).split('\n')[0]}`)
    console.log()
    continue
  }

  // Does the RPC serve state at all? A known-good control for a live ENS name.
  await tryIt('getEnsAddress(eth)', () => getEnsAddress(client, { name: 'eth.eth' }))

  // The actual reads under investigation.
  await tryIt('getEnsResolver(name)', () => getEnsResolver(client, { name: NAME }))
  await tryIt('getEnsAddress(name)', () => getEnsAddress(client, { name: NAME }))
  await tryIt(`getEnsText(${KEY})`, () => getEnsText(client, { name: NAME, key: KEY }))
  await tryIt('getEnsText(avatar)', () => getEnsText(client, { name: NAME, key: 'avatar' }))

  // Raw registry ownership, bypassing the Universal Resolver entirely.
  await tryIt('registry.owner(name)', async () => {
    const owner = await client.readContract({
      address: LEGACY_REGISTRY,
      abi: [
        {
          type: 'function',
          name: 'owner',
          stateMutability: 'view',
          inputs: [{ name: 'node', type: 'bytes32' }],
          outputs: [{ name: '', type: 'address' }],
        },
      ],
      functionName: 'owner',
      args: [namehash(NAME)],
    })
    return owner === ZERO ? `${ZERO} (UNREGISTERED in legacy registry)` : owner
  })
  console.log()
}

console.log('Legend: a THREW row means the resolver could not be reached or the name failed')
console.log('to resolve. A null/zero row means resolution succeeded but found nothing.')