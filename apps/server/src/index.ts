import type { PublicClient } from 'viem'
import { createApp } from './app'
import { devHumanVerifier, type HumanVerifier } from './auth/human'
import { chain, pollingInterval, publicClient, rpcUrl } from './chain/client'
import { contractsOn } from './chain/contracts'
import { createArenaOps } from './chain/operator'
import type { AppContext } from './context'
import { openDb } from './db'
import { env } from './env'
import { KeyBox } from './wallets/keybox'

// Server-only work: agent keys, policy engine, 0G and Flash calls, scheduler, resolver.
const { db, kind: dbKind } = await openDb(env.databaseUrl)
const contracts = contractsOn(chain.id)
const client = publicClient as unknown as PublicClient

function humanVerifier(): HumanVerifier {
  if (env.humanVerifier === 'dev') {
    console.warn('[server] HUMAN_VERIFIER=dev: owners are NOT World-verified (local anvil only)')
    return devHumanVerifier
  }
  throw new Error('World ID verification arrives in Phase 6; set HUMAN_VERIFIER=dev on anvil')
}

const ctx: AppContext = {
  db,
  chain,
  rpcUrl,
  pollingInterval,
  publicClient: client,
  contracts,
  arena: createArenaOps({
    arena: contracts.arena,
    operatorKey: env.operatorKey,
    chain,
    rpcUrl,
    publicClient: client,
    pollingInterval,
  }),
  keyBox: new KeyBox(env.masterKey),
  humanVerifier: humanVerifier(),
  flashSettlement: env.flash.settlement,
  now: Date.now,
}

createApp(ctx, env.corsOrigins).listen(env.port, (error) => {
  if (error) throw error
  console.log(
    `[server] http://localhost:${env.port} · chain ${chain.id} (${chain.name}) · rpc ${rpcUrl} · db ${dbKind}`,
  )
})
