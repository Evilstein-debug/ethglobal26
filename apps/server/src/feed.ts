/**
 * Escrow activity feed: polls SimpleEscrow events with eth_getLogs over a block cursor and keeps
 * the latest entries in memory (a restart clears them). Swap for a database if you need history.
 */
import { addressOn } from '@starter/shared/chains'
import { simpleEscrowAbi, simpleEscrowAddress } from '@starter/shared/generated'
import { formatEther, parseEventLogs } from 'viem'
import { chain, publicClient } from './chain'

export type FeedEntry = {
  id: number
  timestamp: string
  message: string
  txHash: string
  blockNumber: string
}

const MAX_ENTRIES = 100
const MAX_RANGE = 1_000n
const POLL_MS = chain.id === 31337 ? 1_000 : 4_000

const entries: FeedEntry[] = []
let nextId = 1
let cursor: bigint | undefined

/** Newest first. */
export function listFeed(limit = 50) {
  return entries.slice(-limit).reverse()
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

async function poll(address: `0x${string}`) {
  const head = await publicClient.getBlockNumber()
  if (cursor === undefined || cursor > head + 1n) cursor = head + 1n // first run, or chain rewound
  if (cursor > head) return

  const toBlock = head - cursor >= MAX_RANGE ? cursor + MAX_RANGE - 1n : head
  const logs = await publicClient.getLogs({ address, fromBlock: cursor, toBlock })
  for (const log of parseEventLogs({ abi: simpleEscrowAbi, logs })) {
    const message =
      log.eventName === 'DealCreated'
        ? `Deal #${log.args.id} created: ${formatEther(log.args.amount)} ETH from ${short(log.args.payer)} to ${short(log.args.payee)}`
        : log.eventName === 'DealReleased'
          ? `Deal #${log.args.id} released: ${formatEther(log.args.amount)} ETH to ${short(log.args.payee)}`
          : `Deal #${log.args.id} refunded: ${formatEther(log.args.amount)} ETH to ${short(log.args.payer)}`
    entries.push({
      id: nextId++,
      timestamp: new Date().toISOString(),
      message,
      txHash: log.transactionHash,
      blockNumber: log.blockNumber.toString(),
    })
    if (entries.length > MAX_ENTRIES) entries.shift()
    console.log(`[feed] ${message} (${log.transactionHash})`)
  }
  cursor = toBlock + 1n
}

export function startFeed() {
  const address = addressOn(simpleEscrowAddress, chain.id)
  if (!address) {
    console.warn(`[feed] SimpleEscrow is not deployed on chain ${chain.id}; feed disabled`)
    return
  }
  const tick = async () => {
    try {
      await poll(address)
    } catch (error) {
      console.warn('[feed] poll failed:', error instanceof Error ? error.message : error)
    }
    setTimeout(tick, POLL_MS)
  }
  void tick()
}
