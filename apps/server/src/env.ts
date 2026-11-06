/**
 * Server configuration from the environment. Local anvil runs with zero configuration: missing
 * secrets fall back to clearly-labeled LOCAL-ONLY defaults. On any real chain every secret is
 * required and the dev fallbacks are refused.
 */
import { resolve } from 'node:path'
import { isLocalChain, parseChainId } from '@starter/shared/chains'
import { isAddress, type Address, type Hex } from 'viem'

const chainId = parseChainId(process.env.CHAIN_ID)
const local = isLocalChain(chainId)

/** LOCAL ONLY. Public anvil dev account #0 (from the documented test mnemonic). */
const ANVIL_ACCOUNT_0_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
/** LOCAL ONLY. A fixed, public master key so local agent keys survive restarts. */
const LOCAL_DEV_MASTER_KEY = 'de'.repeat(32)

function secret(name: string, localDefault: string): string {
  const value = process.env[name]
  if (value) return value
  if (local) return localDefault
  throw new Error(`${name} is required on chain ${chainId} (see apps/server/.env.example)`)
}

function addressList(name: string): Address[] {
  const values = (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const v of values) if (!isAddress(v)) throw new Error(`${name}: not an address: ${v}`)
  return values as Address[]
}

export const env = {
  chainId,
  isLocal: local,
  rpcUrl: process.env.RPC_URL || undefined,
  port: Number(process.env.PORT) || 8787,
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim()),
  /**
   * postgres://… (Neon in production) or a local PGlite directory.
   * Default: apps/server/data/pglite-<chainId> (gitignored), one database per chain.
   */
  databaseUrl:
    process.env.DATABASE_URL || resolve(import.meta.dirname, `../data/pglite-${chainId}`),
  masterKey: secret('MASTER_KEY', LOCAL_DEV_MASTER_KEY),
  operatorKey: secret('OPERATOR_PRIVATE_KEY', ANVIL_ACCOUNT_0_KEY) as Hex,
  flash: {
    apiKey: process.env.FLASH_API_KEY || undefined,
    baseUrl: process.env.FLASH_API_BASE_URL || 'https://flash.definitive.fi/v1',
    integratorFeeBps: process.env.FLASH_INTEGRATOR_FEE_BPS || '0',
    /** From a real quote's evm.approveTx spender (scripts/flash-inspect.ts). */
    approvalSpenders: addressList('FLASH_APPROVAL_SPENDERS'),
    /** From a real quote's orderTypedData domain.verifyingContract. */
    typedDataContracts: addressList('FLASH_TYPED_DATA_CONTRACTS'),
    /** Optional ERC-8021 builder code (base.dev) attached to order submits. */
    attributionCode: process.env.FLASH_ATTRIBUTION_CODE || undefined,
  },
  /** LOCAL ANVIL ONLY: real ETH/USD spot price for the Flash stub. Empty keeps the fixed price. */
  localPriceFeedUrl: local ? process.env.LOCAL_PRICE_FEED_URL || undefined : undefined,
  /** Optional RSS/Atom feeds for agents; without them they read the labeled fixture headlines. */
  newsRssUrls: (process.env.NEWS_RSS_URLS ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean),
  zerog: {
    apiKey: process.env.ZEROG_API_KEY || undefined,
    baseUrl: process.env.ZEROG_BASE_URL || 'https://router-api.0g.ai/v1',
    /** 0G chain, read to check each provider's TEE signature ourselves. */
    rpcUrl: process.env.ZG_RPC_URL || 'https://evmrpc.0g.ai',
    /** TeeML models only (sealed inference). */
    model: process.env.ZEROG_MODEL || 'glm-5.3',
    /** Sealed models think for a while: 12-60s or more was measured on glm-5.3. */
    timeoutMs: Number(process.env.ZEROG_TIMEOUT_MS) || 150_000,
    /** Minimum take-profit distance (fraction); set from measured Flash round-trip fees. */
    minTpPct: process.env.TRADE_MIN_TP_PCT ? Number(process.env.TRADE_MIN_TP_PCT) : undefined,
  },
  /**
   * Hand-written trades (no 0G decision) for smoke-testing the Flash pipeline. Default: only on
   * local anvil. Set to "true" on Base for the one-off first-trade check, then turn it off.
   */
  allowManualTrades: process.env.ALLOW_MANUAL_TRADES
    ? process.env.ALLOW_MANUAL_TRADES === 'true'
    : local,
  world: {
    appId: process.env.WORLD_APP_ID || undefined,
    rpId: process.env.WORLD_RP_ID || undefined,
    /** Secret. Never sent to the browser. */
    signingKey: process.env.WORLD_RP_SIGNING_KEY || undefined,
    action: process.env.WORLD_ACTION || 'agentarena-owner-v1',
    environment: (process.env.WORLD_ENVIRONMENT === 'staging' ? 'staging' : 'production') as
      'production' | 'staging',
  },
  /** Wakes trading agents when the WETH price moves (brain/watcher.ts). */
  watcher: {
    pollMs: Number(process.env.WAKE_POLL_MS) || 30_000,
    movePct: Number(process.env.WAKE_PRICE_MOVE_PCT) || 0.5,
    minGapMs: Number(process.env.WAKE_MIN_GAP_MS ?? 300_000),
  },
  markets: {
    enabled: (process.env.AGENTS_ENABLED ?? 'true') === 'true',
    predictionWindowMs: Number(process.env.PREDICTION_WINDOW_MS) || 300_000,
    maxHoldMs: Number(process.env.TRADE_MAX_HOLD_MS) || 1_800_000,
    cooldownMs: Number(process.env.TRADE_COOLDOWN_MS ?? 300_000),
    thinkEveryMs: Number(process.env.AGENT_THINK_MS) || 60_000,
    /** Tool calls an agent may make per thought before it must decide (0 = no tools). */
    maxSteps: Number(process.env.AGENT_MAX_STEPS ?? 4) || 0,
    epochMs: Number(process.env.REWARD_EPOCH_MS) || 3_600_000,
    epochBudget: Number(process.env.REWARD_EPOCH_BUDGET) || 5_000_000,
    minEntries: Number(process.env.REWARD_MIN_ENTRIES) || 1,
    minPredictions: Number(process.env.REWARD_MIN_PREDICTIONS) || 2,
  },
  /**
   * How owners prove they're human. 'world' verifies IDKit proofs with World (Phase 6).
   * 'dev' accepts a made-up identity and is refused anywhere but local anvil.
   */
  humanVerifier: (process.env.HUMAN_VERIFIER || (local ? 'dev' : 'world')) as 'world' | 'dev',
}

if (env.humanVerifier === 'dev' && !local) {
  throw new Error('HUMAN_VERIFIER=dev is only allowed on local anvil')
}
