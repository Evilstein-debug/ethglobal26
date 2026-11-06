import { createZGComputeNetworkBroker } from '@0gfoundation/0g-compute-ts-sdk'
import { FlashClient, LocalFlashStub } from '@starter/flash'
import { arenaAbi, mockUsdcAbi } from '@starter/shared/generated'
import { ethers } from 'ethers'
import {
  createWalletClient,
  getAddress,
  http,
  parseEther,
  parseUnits,
  zeroHash,
  type Address,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { createApp } from './app'
import { rpSignature } from '@starter/world'
import { devHumanVerifier, worldHumanVerifier, type HumanVerifier } from './auth/human'
import { chain, pollingInterval, publicClient, rpcUrl } from './chain/client'
import { contractsOn } from './chain/contracts'
import { createArenaOps } from './chain/operator'
import { DEFAULT_BRAIN, DEV_FAUCET, type AppContext, type FlashSetup } from './context'
import { ZeroGClient, type LLMClient } from '@starter/zerog'
import { candleReader } from './brain/candles'
import { localModel } from './brain/local-model'
import { startPriceWatcher } from './brain/watcher'
import { newsReader } from './brain/news'
import { openDb, schema } from './db'
import { env } from './env'
import { restoreStubPositions } from './execution/close'
import { startPredictionIndexer } from './rounds/indexer'
import { startScheduler } from './rounds/scheduler'
import { startPriceFeed } from './services/price-feed'
import { KeyBox } from './wallets/keybox'

// Server-only work: agent keys, policy engine, 0G and Flash calls, scheduler, resolver.
const { db, kind: dbKind } = await openDb(env.databaseUrl)
const contracts = contractsOn(chain.id)
const client = publicClient as unknown as PublicClient

const w = env.world
const worldConfig =
  w.appId && w.rpId && w.signingKey
    ? {
        appId: w.appId,
        rpId: w.rpId,
        signingKeyHex: w.signingKey,
        action: w.action,
        environment: w.environment,
      }
    : undefined

function humanVerifier(): HumanVerifier {
  if (env.humanVerifier === 'dev') {
    console.warn('[server] HUMAN_VERIFIER=dev: owners are NOT World-verified (local anvil only)')
    return devHumanVerifier
  }
  if (!worldConfig) {
    throw new Error('HUMAN_VERIFIER=world needs WORLD_APP_ID, WORLD_RP_ID and WORLD_RP_SIGNING_KEY')
  }
  console.log(`[server] World ID: ${worldConfig.environment}, action ${worldConfig.action}`)
  return worldHumanVerifier(worldConfig)
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

/**
 * Checks each provider's TEE signature against 0G's chain ourselves, without trusting the Router.
 * The wallet is throwaway: this only reads. A signature can lag the response by a moment.
 */
function teeVerifier() {
  let broker: Awaited<ReturnType<typeof createZGComputeNetworkBroker>> | undefined
  return async (provider: string, chatId: string) => {
    broker ??= await createZGComputeNetworkBroker(
      new ethers.Wallet(
        ethers.Wallet.createRandom().privateKey,
        new ethers.JsonRpcProvider(env.zerog.rpcUrl),
      ),
    )
    const { inference } = broker
    for (let attempt = 0; ; attempt++) {
      const ok = await inference.processResponse(provider, chatId).catch(() => null)
      if (ok !== null || attempt === 2) return ok
      await new Promise((r) => setTimeout(r, 1000))
    }
  }
}

function llm(): LLMClient | undefined {
  if (env.zerog.apiKey) {
    return new ZeroGClient({
      apiKey: env.zerog.apiKey,
      baseUrl: env.zerog.baseUrl,
      model: env.zerog.model,
      timeoutMs: env.zerog.timeoutMs,
      verifyTee: teeVerifier(),
    })
  }
  if (env.isLocal) {
    console.warn('[server] 0G: LOCAL STUB model (decisions labeled "local-stub", not 0G)')
    return localModel()
  }
  console.warn('[server] ZEROG_API_KEY not set: agents cannot decide')
  return undefined
}

/** LOCAL ANVIL ONLY: the operator (a funded anvil dev account) mints mock USDC and sends ETH. */
function localFaucet() {
  const operator = createWalletClient({
    account: privateKeyToAccount(env.operatorKey),
    chain,
    transport: http(rpcUrl),
    pollingInterval,
  })
  return async (to: Address) => {
    const usdcTx = await operator.writeContract({
      address: contracts.usdc,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [to, parseUnits(DEV_FAUCET.usdc, 6)],
    })
    const ethTx = await operator.sendTransaction({ to, value: parseEther(DEV_FAUCET.eth) })
    for (const hash of [usdcTx, ethTx]) await client.waitForTransactionReceipt({ hash })
    return { usdcTx, ethTx }
  }
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
  world: worldConfig && {
    appId: worldConfig.appId,
    rpId: worldConfig.rpId,
    action: worldConfig.action,
    environment: worldConfig.environment,
    sign: () => rpSignature(worldConfig),
  },
  flash: flashSetup(),
  allowManualTrades: env.allowManualTrades,
  llm: llm(),
  markets: {
    predictionWindowMs: env.markets.predictionWindowMs,
    maxHoldMs: env.markets.maxHoldMs,
    thinkEveryMs: env.markets.thinkEveryMs,
    minGasWei: parseEther('0.00001'),
    closeGraceMs: 300_000,
    epochMs: env.markets.epochMs,
    epoch: {
      budget: env.markets.epochBudget,
      minEntries: env.markets.minEntries,
      minPredictions: env.markets.minPredictions,
    },
  },
  devTools: env.isLocal,
  livePrices: Boolean(env.localPriceFeedUrl),
  devFaucet: env.isLocal ? localFaucet() : undefined,
  readNews: newsReader(env.newsRssUrls),
  brain: {
    ...DEFAULT_BRAIN,
    minTpPct: env.zerog.minTpPct ?? DEFAULT_BRAIN.minTpPct,
    tradeCooldownMs: env.markets.cooldownMs,
  },
  now: Date.now,
}

/** A database outlives anvil: refuse to run against a chain that has never seen its owners. */
async function assertDatabaseMatchesChain() {
  const [owner] = await ctx.db.select().from(schema.owners).limit(1)
  if (!owner) return
  const human = await client.readContract({
    address: contracts.arena,
    abi: arenaAbi,
    functionName: 'humanOf',
    args: [getAddress(owner.wallet)],
  })
  if (human === zeroHash) {
    throw new Error(
      `DATABASE_URL holds owner ${owner.wallet}, who is not on this local chain. Either this database is shared with another machine (each person needs their own: a Neon branch works), or it's from an older chain. \`pnpm dev:reset\` empties the whole database, so check it isn't shared first.`,
    )
  }
}

createApp(ctx, env.corsOrigins).listen(env.port, (error) => {
  if (error) throw error
  console.log(
    `[server] http://localhost:${env.port} · chain ${chain.id} (${chain.name}) · rpc ${rpcUrl} · db ${dbKind}`,
  )
})

if (env.isLocal) await assertDatabaseMatchesChain()
await restoreStubPositions(ctx)
if (env.localPriceFeedUrl && ctx.flash?.stub) {
  await startPriceFeed(ctx.flash.stub, env.localPriceFeedUrl)
  console.log('[server] WETH price: live, fills still simulated')
}

// Candles come from a real market, so skip them when the local stub's fake price is in use.
if (ctx.flash && (!ctx.flash.stub || ctx.livePrices)) ctx.readCandles = candleReader()

startPredictionIndexer(ctx)
if (env.markets.enabled) {
  startScheduler(ctx, ctx.markets!)
  startPriceWatcher(ctx, env.watcher)
  const m = env.markets
  console.log(
    `[server] agents think every ${m.thinkEveryMs / 1000}s; markets: ${m.predictionWindowMs / 1000}s to predict, ${m.maxHoldMs / 1000}s max hold, epoch ${m.epochMs / 60000} min`,
  )
} else {
  console.log('[server] agent loop disabled (AGENTS_ENABLED=false)')
}
