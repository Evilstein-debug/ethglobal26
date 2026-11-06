import { FlashClient, LocalFlashStub } from '@starter/flash'
import type { Address, PublicClient } from 'viem'
import { createApp } from './app'
import { devHumanVerifier, type HumanVerifier } from './auth/human'
import { chain, pollingInterval, publicClient, rpcUrl } from './chain/client'
import { contractsOn } from './chain/contracts'
import { createArenaOps } from './chain/operator'
import { DEFAULT_BRAIN, type AppContext, type FlashSetup } from './context'
import { ZeroGClient, type LLMClient } from '@starter/zerog'
import { localModel } from './brain/local-model'
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

function flashSetup(): FlashSetup | undefined {
  const timing = { pollMs: env.isLocal ? 100 : 1500, fillTimeoutMs: env.isLocal ? 10_000 : 90_000 }
  if (env.flash.apiKey) {
    if (!env.flash.approvalSpenders.length || !env.flash.typedDataContracts.length) {
      console.warn(
        '[server] FLASH_API_KEY set but FLASH_APPROVAL_SPENDERS / FLASH_TYPED_DATA_CONTRACTS are empty: run scripts/flash-inspect.ts. Trading disabled.',
      )
      return undefined
    }
    return {
      api: new FlashClient({ apiKey: env.flash.apiKey, baseUrl: env.flash.baseUrl }),
      chain: 'base',
      integratorFeeBps: env.flash.integratorFeeBps,
      attributionCode: env.flash.attributionCode,
      approvalSpenders: env.flash.approvalSpenders,
      typedDataContracts: env.flash.typedDataContracts,
      ...timing,
    }
  }
  if (!env.isLocal) {
    console.warn('[server] FLASH_API_KEY not set: trading disabled')
    return undefined
  }
  // LOCAL TEST ONLY: in-memory Flash stand-in with labeled fake addresses and fills.
  const stubSettlement = '0x000000000000000000000000000000000000F1a5' as Address
  const stub = new LocalFlashStub({
    chainId: chain.id,
    verifyingContract: stubSettlement,
    spender: stubSettlement,
    usdc: contracts.usdc,
    weth: contracts.weth!,
    priceUsd: 3000,
  })
  console.warn('[server] Flash: LOCAL STUB (no real orders; fills are fake)')
  return {
    api: stub,
    stub,
    chain: 'base',
    integratorFeeBps: '0',
    approvalSpenders: [stubSettlement],
    typedDataContracts: [stubSettlement],
    ...timing,
  }
}

function llm(): LLMClient | undefined {
  if (env.zerog.apiKey) {
    return new ZeroGClient({
      apiKey: env.zerog.apiKey,
      baseUrl: env.zerog.baseUrl,
      model: env.zerog.model,
    })
  }
  if (env.isLocal) {
    console.warn('[server] 0G: LOCAL STUB model (decisions labeled "local-stub", not 0G)')
    return localModel()
  }
  console.warn('[server] ZEROG_API_KEY not set: agents cannot decide')
  return undefined
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
  flash: flashSetup(),
  allowManualTrades: env.allowManualTrades,
  llm: llm(),
  brain: { ...DEFAULT_BRAIN, minTpPct: env.zerog.minTpPct ?? DEFAULT_BRAIN.minTpPct },
  now: Date.now,
}

createApp(ctx, env.corsOrigins).listen(env.port, (error) => {
  if (error) throw error
  console.log(
    `[server] http://localhost:${env.port} · chain ${chain.id} (${chain.name}) · rpc ${rpcUrl} · db ${dbKind}`,
  )
})
