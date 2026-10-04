/**
 * Entry point for the community people finder UI.
 *
 *   npm start                      # reads Sepolia (needs SEPOLIA_RPC_URL)
 *   USE_FIXTURES=1 npm start       # offline demo against the 9 in-memory fixtures
 *   PORT=4000 npm start
 */

import { loadEnvFile } from '../lib/env.js'
import { loadLlmConfig } from '../lib/llm-config.js'
import { createApp } from './app.js'
import { CommunityState } from './community-state.js'

loadEnvFile()

const port = Number.parseInt(process.env.PORT ?? '3000', 10)
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`  PORT must be a number between 1 and 65535, got ${JSON.stringify(process.env.PORT)}.`)
  process.exit(1)
}

const useFixtures = process.env.USE_FIXTURES === '1'

let state: CommunityState
try {
  state = await CommunityState.create({ useFixtures })
} catch (error) {
  console.error('\n  Could not build the community index.\n')
  console.error(`  ${error instanceof Error ? error.message : String(error)}\n`)
  console.error('  For an offline demo with no RPC endpoint, run:  USE_FIXTURES=1 npm start\n')
  process.exit(1)
}

const status = state.status
if (status.degraded)
  console.warn(
    `\n  WARNING: 0 profiles readable from chain. The roster is probably not seeded yet.`,
  )

const config = loadLlmConfig()
const server = createApp({ state })

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n  Port ${port} is already in use.`)
    console.error(`  Try another port:  PORT=3001 npm start\n`)
    process.exit(1)
  }
  if (error.code === 'EACCES') {
    console.error(`\n  Not allowed to listen on port ${port}. Ports below 1024 need extra privileges.`)
    console.error(`  Try:  PORT=3000 npm start\n`)
    process.exit(1)
  }
  throw error
})

server.listen(port, () => {
  console.log(`\n  Community people finder listening on http://localhost:${port}\n`)
  console.log(`  Data source : ${status.source === 'chain' ? 'live Sepolia reads' : 'in-memory fixtures'}`)
  console.log(`  Profiles    : ${status.stats.documents} indexed (${status.names.length} rostered)`)
  console.log(`  Embeddings  : ${status.embeddingProvider ?? 'none (lexical only)'}`)
  console.log(`  Model       : ${config.model}`)
  console.log(`  Endpoint    : ${config.baseUrl}`)
  // Printed without the key: an API key must never reach a log line or a scrollback.
  console.log(`  API key     : ${config.apiKey === '' ? '(none)' : '(set)'}\n`)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
