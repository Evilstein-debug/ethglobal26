/**
 * The operator wallet's Arena calls. Each one simulates first (so a revert reason surfaces before
 * gas is spent), sends, waits for the receipt and returns the tx hash plus decoded results.
 */
import { arenaAbi } from '@starter/shared/generated'
import {
  createWalletClient,
  http,
  parseEventLogs,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

export type Outcome = 'YES' | 'NO' | 'VOID'
const OUTCOME_CODE: Record<Outcome, number> = { YES: 1, NO: 2, VOID: 3 }

export type ArenaOps = {
  address: Address
  registerOwner(owner: Address, humanId: Hex): Promise<Hash>
  registerAgent(agent: Address, humanId: Hex): Promise<Hash>
  openEntry(roundId: number, trader: Address): Promise<{ hash: Hash; entryId: number }>
  lockPredictions(roundId: number): Promise<Hash>
  resolveEntry(entryId: number, outcome: Outcome, pnlBps: number): Promise<Hash>
  publishEpoch(epoch: number, humanIds: Hex[], amounts: bigint[]): Promise<Hash>
  humanOf(account: Address): Promise<Hex>
}

export function createArenaOps(opts: {
  arena: Address
  operatorKey: Hex
  chain: Chain
  rpcUrl: string
  publicClient: PublicClient
  pollingInterval?: number
}): ArenaOps {
  const account = privateKeyToAccount(opts.operatorKey)
  const wallet = createWalletClient({
    account,
    chain: opts.chain,
    transport: http(opts.rpcUrl),
    pollingInterval: opts.pollingInterval,
  })
  const pc = opts.publicClient

  // One operator wallet: serialize writes so nonces never collide.
  let queue: Promise<unknown> = Promise.resolve()
  async function write(functionName: string, args: readonly unknown[]) {
    const run = async () => {
      const { request } = await pc.simulateContract({
        account,
        address: opts.arena,
        abi: arenaAbi,
        functionName: functionName as never,
        args: args as never,
      })
      const hash = await wallet.writeContract(request as never)
      const receipt = await pc.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`Arena.${functionName} reverted (${hash})`)
      return receipt
    }
    const next = queue.then(run, run)
    queue = next.catch(() => undefined)
    return next
  }

  return {
    address: opts.arena,
    async registerOwner(owner, humanId) {
      return (await write('registerOwner', [owner, humanId])).transactionHash
    },
    async registerAgent(agent, humanId) {
      return (await write('registerAgent', [agent, humanId])).transactionHash
    },
    async openEntry(roundId, trader) {
      const receipt = await write('openEntry', [BigInt(roundId), trader])
      const [log] = parseEventLogs({ abi: arenaAbi, eventName: 'EntryOpened', logs: receipt.logs })
      if (!log) throw new Error('EntryOpened not emitted')
      return { hash: receipt.transactionHash, entryId: Number(log.args.entryId) }
    },
    async lockPredictions(roundId) {
      return (await write('lockPredictions', [BigInt(roundId)])).transactionHash
    },
    async resolveEntry(entryId, outcome, pnlBps) {
      return (await write('resolveEntry', [BigInt(entryId), OUTCOME_CODE[outcome], BigInt(pnlBps)]))
        .transactionHash
    },
    async publishEpoch(epoch, humanIds, amounts) {
      return (await write('publishEpoch', [BigInt(epoch), humanIds, amounts])).transactionHash
    },
    async humanOf(acct) {
      return pc.readContract({
        address: opts.arena,
        abi: arenaAbi,
        functionName: 'humanOf',
        args: [acct],
      })
    },
  }
}
