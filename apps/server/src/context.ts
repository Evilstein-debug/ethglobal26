import type { FlashApi, FlashChain, LocalFlashStub } from '@starter/flash'
import type { LLMClient } from '@starter/zerog'
import type { CandleSet } from './brain/candles'
import type { News } from './brain/news'
import type { MarketConfig } from './rounds/scheduler'
import type { Address, Chain, PublicClient } from 'viem'
import type { HumanVerifier } from './auth/human'
import type { ArenaOps } from './chain/operator'
import type { Contracts } from './chain/contracts'
import type { Db } from './db'
import type { KeyBox } from './wallets/keybox'

/** Everything a route or worker needs. Built once in index.ts; tests build their own. */
/** LOCAL ANVIL ONLY: what one click of the dev faucet gives a wallet. */
export const DEV_FAUCET = { usdc: '1000', eth: '20' }

export type AppContext = {
  db: Db
  chain: Chain
  rpcUrl: string
  pollingInterval?: number
  publicClient: PublicClient
  contracts: Contracts
  arena: ArenaOps
  keyBox: KeyBox
  humanVerifier: HumanVerifier
  /** Undefined when Flash isn't configured: trades are refused with `flash_not_configured`. */
  flash?: FlashSetup
  allowManualTrades: boolean
  /** The agents' brain: 0G in production; a labeled local stub only on anvil. */
  llm?: LLMClient
  brain: BrainConfig
  /** What agents read before deciding. Untrusted data. */
  readNews: () => Promise<News>
  /** Recent price candles for agents. Absent where there is no real price (local stub). */
  readCandles?: () => Promise<CandleSet | null>
  /** Market timing and reward settings (scheduler). */
  markets?: MarketConfig
  /** Public World ID settings for the browser (IDKit) + server-side RP signing. */
  world?: {
    appId: string
    rpId: string
    action: string
    environment: 'production' | 'staging'
    sign: () => unknown
  }
  /** The Flash stub is following a real price feed, so its price can't be set by hand. */
  livePrices?: boolean
  /** LOCAL ANVIL ONLY: enables /api/dev/* helpers (stub price, manual round tick). */
  devTools?: boolean
  /** LOCAL ANVIL ONLY: mint mock USDC and send ETH to an address (dev faucet). */
  devFaucet?: (to: Address) => Promise<{ usdcTx: string; ethTx: string }>
  now: () => number
}

/** Code-enforced bounds on model decisions (fractions of price; USDC base units). */
export type BrainConfig = {
  minTrade: number
  minRiskPct: number
  maxRiskPct: number
  /** Must cover Flash round-trip fees so a YES outcome is reachable. */
  minTpPct: number
  maxTpPct: number
  minRewardRisk: number
  /** Minimum time between two trades of one agent. */
  tradeCooldownMs: number
  /** How many tool calls an agent may make in one thought before it must decide. */
  maxSteps: number
  /** Limits on TWAP entries and on how far the crowd may trim them (execution/twap.ts). */
  twap: TwapConfig
  /** Limits on limit entries (execution/resting.ts). */
  limit: LimitConfig
}

export type LimitConfig = {
  /** How far below the live price the limit may sit, as fractions of price (0.003 = 0.3%). */
  minDipPct: number
  maxDipPct: number
  /** How long the order may rest before it is cancelled unfilled. */
  minWaitSeconds: number
  maxWaitSeconds: number
}

export type TwapConfig = {
  /** Flash's own minimum is 300s; the model may pick anything in [minSeconds, maxSeconds]. */
  minSeconds: number
  maxSeconds: number
  minBuckets: number
  maxBuckets: number
  /** Smallest tranche, USDC base units. */
  minSlice: number
  /** Predictions needed before the crowd can cancel the rest. With fewer, the TWAP just runs. */
  minVoters: number
  /** The mean probability of YES (bps) at or below which the remaining tranches are cancelled. */
  trimAtOrBelowBps: number
}

export const DEFAULT_BRAIN: BrainConfig = {
  minTrade: 1_000_000,
  minRiskPct: 0.003,
  maxRiskPct: 0.05,
  minTpPct: 0.008,
  maxTpPct: 0.1,
  minRewardRisk: 1,
  tradeCooldownMs: 0,
  maxSteps: 4,
  twap: {
    minSeconds: 300,
    maxSeconds: 900,
    minBuckets: 2,
    maxBuckets: 6,
    minSlice: 500_000,
    minVoters: 1,
    trimAtOrBelowBps: 4_500,
  },
  limit: { minDipPct: 0.001, maxDipPct: 0.03, minWaitSeconds: 300, maxWaitSeconds: 1_800 },
}

export type FlashSetup = {
  api: FlashApi
  /** Present only on local anvil (LOCAL TEST ONLY): lets dev tooling move the stub's price. */
  stub?: LocalFlashStub
  chain: FlashChain
  integratorFeeBps: string
  attributionCode?: string
  approvalSpenders: Address[]
  typedDataContracts: Address[]
  /** Poll cadence while waiting for fills. */
  pollMs: number
  fillTimeoutMs: number
  /**
   * How long a market entry listens to the Quotes WebSocket before signing the newest quote.
   * 0 (or an API without streaming) quotes once over REST.
   */
  quoteWindowMs?: number
}
