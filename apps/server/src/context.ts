import type { FlashApi, FlashChain, LocalFlashStub } from '@starter/flash'
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
  now: () => number
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
