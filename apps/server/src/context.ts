import type { FlashApi, FlashChain, LocalFlashStub } from '@starter/flash'
import type { LLMClient } from '@starter/zerog'
import type { RoundConfig } from './rounds/scheduler'
import type { Address, Chain, PublicClient } from 'viem'
import type { HumanVerifier } from './auth/human'
import type { ArenaOps } from './chain/operator'
import type { Contracts } from './chain/contracts'
import type { Db } from './db'
import type { KeyBox } from './wallets/keybox'

/** Everything a route or worker needs. Built once in index.ts; tests build their own. */
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
  /** Round timing and reward settings (scheduler). */
  rounds?: RoundConfig
  /** LOCAL ANVIL ONLY: enables /api/dev/* helpers (stub price, manual round tick). */
  devTools?: boolean
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
}

export const DEFAULT_BRAIN: BrainConfig = {
  minTrade: 1_000_000,
  minRiskPct: 0.003,
  maxRiskPct: 0.05,
  minTpPct: 0.008,
  maxTpPct: 0.1,
  minRewardRisk: 1,
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
}
