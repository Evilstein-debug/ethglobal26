import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keccak256, toBytes, type Address, type PublicClient } from 'viem'
import { canonicalJson } from './canonical'
import { LOCAL_CHAIN_ID } from './chains'
import { expectedOutcome, verifyEntry, type EntryBundle } from './verify'

const BASE = 8453
const addr = (n: number) => `0x${String(n).padStart(40, '0')}` as Address
const tx = (n: number) => `0x${String(n).padStart(64, '0')}`
const AGENT = addr(1)
const OWNER = addr(2)
const FLASH = addr(3)

const json = canonicalJson({ roundId: 1, agentAddress: AGENT })
const intent = (over: Partial<EntryBundle['intents'][number]> = {}) => ({
  intentId: 'i1',
  roundId: 1,
  canonicalJson: json,
  intentHash: keccak256(toBytes(json)),
  state: 'CLOSED',
  sizeQuote: 5_000_000,
  stopPrice: '1',
  targetPrice: '2',
  entryRefPrice: '1.5',
  decisionId: null,
  commitTx: tx(1),
  recordTx: tx(5),
  failReason: null,
  entryFillTx: tx(2),
  exitFillTx: tx(3),
  usdcSpent: 5_000_000,
  usdcReceived: 5_100_000,
  ...over,
})
const prediction = (over: Partial<EntryBundle['predictions'][number]> = {}) => ({
  predictionId: 'p',
  predictorKind: 'agent' as const,
  predictorAddress: OWNER,
  side: 'YES' as const,
  probYesBps: 5000,
  decisionId: null,
  predictTx: tx(5),
  brier: 0.25,
  ...over,
})
const bundle = (over: Partial<EntryBundle> = {}): EntryBundle => ({
  entry: {
    id: 1,
    roundId: 1,
    onchainEntryId: 1,
    outcome: 'YES',
    pnlBps: 200,
    voidReason: null,
    openTx: tx(9),
    resolveTx: tx(4),
  },
  round: { id: 1, phase: 'SETTLED', lockTx: null },
  trader: { id: 'a', name: 'Alpha', address: AGENT, owner: OWNER },
  intents: [intent()],
  predictions: [],
  decisions: [],
  contracts: { tradeLog: addr(10), arena: addr(11), usdc: addr(12) },
  ...over,
})

type Transfer = { from: Address; to: Address; value: bigint }
/** Just enough of a chain for the fill steps. `blocks` maps tx hash → block number. */
function chain(blocks: Record<string, number>, transfers: Transfer[]) {
  return {
    getTransactionReceipt: async ({ hash }: { hash: string }) => {
      if (!(hash in blocks)) throw new Error(`tx not found: ${hash}`)
      return {
        status: 'success',
        blockNumber: BigInt(blocks[hash]!),
        transactionIndex: 0,
        logs: [],
      }
    },
    getBlockNumber: async () => 100n,
    readContract: async () => {
      throw new Error('not used')
    },
    getLogs: async ({ args }: { args: { from?: Address; to?: Address } }) =>
      transfers
        .filter((t) => (args.from ? t.from === args.from : t.to === args.to))
        .map((t) => ({ args: t })),
  } as unknown as PublicClient
}
const BLOCKS = { [tx(1)]: 1, [tx(2)]: 2, [tx(9)]: 3, [tx(3)]: 4, [tx(4)]: 5, [tx(5)]: 3 }
const TRADES: Transfer[] = [
  { from: AGENT, to: FLASH, value: 5_000_000n },
  { from: FLASH, to: AGENT, value: 5_100_000n },
]

async function step(b: EntryBundle, client: PublicClient, id: string, chainId = BASE) {
  const report = await verifyEntry(b, client, { chainId })
  return report.steps.find((s) => s.id === id)!
}

test('fills: USDC moved onchain must match the fills; owner transfers are ignored', async () => {
  const owner: Transfer[] = [
    { from: OWNER, to: AGENT, value: 20_000_000n },
    { from: AGENT, to: OWNER, value: 3_000_000n },
  ]
  const ok = await step(bundle(), chain(BLOCKS, [...TRADES, ...owner]), 'fills-onchain')
  assert.equal(ok.status, 'pass', ok.detail)

  const lied = bundle({ intents: [intent({ usdcReceived: 6_000_000 })] })
  const bad = await step(lied, chain(BLOCKS, TRADES), 'fills-onchain')
  assert.equal(bad.status, 'fail')
  assert.match(bad.detail, /net USDC onchain 0.1, fills claim 1/)
})

test('fills: a commit after its fill fails, and a missing fill fails on Base', async () => {
  const late = await step(
    bundle(),
    chain({ ...BLOCKS, [tx(1)]: 3, [tx(2)]: 2 }, TRADES),
    'commit-before-fill',
  )
  assert.equal(late.status, 'fail')
  assert.match(late.detail, /filled before its commit/)

  const { [tx(2)]: _gone, ...noFill } = BLOCKS
  assert.equal((await step(bundle(), chain(noFill, TRADES), 'commit-before-fill')).status, 'fail')
})

test('fills: a market broadcast before its fill fails', async () => {
  const early = await step(bundle(), chain({ ...BLOCKS, [tx(9)]: 1 }, TRADES), 'commit-before-fill')
  assert.equal(early.status, 'fail')
  assert.match(early.detail, /market opened before fill/)
})

test('brier: a prediction landing once the exit filled must stay unscored', async () => {
  const late = (brier: number | null) =>
    bundle({ predictions: [prediction({ predictTx: tx(6), brier })] })
  const c = chain({ ...BLOCKS, [tx(6)]: 4 }, TRADES)
  assert.equal((await step(late(null), c, 'brier')).status, 'pass')
  const scored = await step(late(0.25), c, 'brier')
  assert.equal(scored.status, 'fail')
  assert.match(scored.detail, /scored after the exit filled/)
})

test('fills: only local anvil may skip the fill steps', async () => {
  const onLocal = await step(bundle(), chain(BLOCKS, []), 'fills-onchain', LOCAL_CHAIN_ID)
  assert.equal(onLocal.status, 'skip')
  assert.equal((await step(bundle(), chain(BLOCKS, []), 'fills-onchain')).status, 'fail')
})

test('decisions: a stub or unverified model never passes on Base', async () => {
  const decision = {
    id: 'd',
    kind: 'think' as const,
    model: 'glm-5.3',
    requestId: 'r',
    provider: 'p',
    chatId: 'c',
    teeVerified: true,
    accepted: true,
    rejectReason: null,
  }
  const b = (over: object) =>
    bundle({
      intents: [],
      predictions: [prediction({ decisionId: 'd' })],
      decisions: [{ ...decision, ...over }],
    })
  const c = chain(BLOCKS, [])
  assert.equal((await step(b({}), c, 'decisions')).status, 'pass')
  assert.equal((await step(b({ teeVerified: false }), c, 'decisions')).status, 'fail')
  assert.equal((await step(b({ model: 'local-stub' }), c, 'decisions')).status, 'fail')
  const report = await verifyEntry(b({}), c, { chainId: BASE, verifyTee: async () => false })
  assert.equal(report.steps.find((s) => s.id === 'decisions')!.status, 'fail')
})

test('expectedOutcome follows the resolver rules', () => {
  assert.deepEqual(expectedOutcome([intent()]).outcome, 'YES')
  assert.equal(expectedOutcome([intent()]).pnlBps, 200)
  assert.equal(expectedOutcome([intent({ usdcReceived: 5_000_000 })]).outcome, 'NO')
  assert.equal(expectedOutcome([]).voidReason, 'no_trades')
  assert.equal(expectedOutcome([intent({ state: 'FAILED' })]).voidReason, 'no_trades')
  assert.equal(expectedOutcome([intent({ state: 'EXECUTED' })]).voidReason, 'unsettled_intent')
})
