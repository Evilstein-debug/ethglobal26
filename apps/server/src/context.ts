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
  /** Flash settlement contract on this chain; unset until verified (Phase 3). */
  flashSettlement?: Address
  now: () => number
}
