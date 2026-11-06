/**
 * Independent entry verification: re-derives one market's entry from public data. Runs the same in
 * the browser (entry page) and in scripts/verify.ts. The server only supplies the claims (the
 * `GET /api/entries/:id` bundle); every step checks them against Base logs, receipts and contract
 * state, and recomputes hashes, PnL and Brier scores locally.
 *
 * Local anvil has no real fills or TEE attestations (labeled stubs), so those steps report `skip`
 * there and never `pass`. Only chain 31337 can skip them: on Base a missing fill is a failure.
 */
import {
  erc20Abi,
  getAbiItem,
  getAddress,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  parseUnits,
  toBytes,
  zeroHash,
  type Address,
  type Hash,
  type PublicClient,
} from 'viem'
import { canonicalHash, idHash } from './canonical'
import { LOCAL_CHAIN_ID } from './chains'
import { arenaAbi, tradeLogAbi } from './generated'
import { USDC_DECIMALS } from './tokens'

export type VerifyDecision = {
  id: string
  kind: 'think' | 'trade' | 'prediction'
  model: string
  requestId: string
  provider: string
  chatId: string | null
  teeVerified: boolean | null
  accepted: boolean
  rejectReason: string | null
}

export type EntryBundle = {
  entry: {
    id: number
    roundId: number
    onchainEntryId: number | null
    outcome: 'PENDING' | 'YES' | 'NO' | 'VOID'
    pnlBps: number | null
    voidReason: string | null
    openTx: string | null
    resolveTx: string | null
  }
  round: { id: number; phase: string; lockTx: string | null }
  trader: { id: string; name: string; address: string; owner: string }
  intents: {
    intentId: string
    roundId: number
    canonicalJson: string
    intentHash: string
    state: string
    sizeQuote: number
    stopPrice: string
    targetPrice: string
    entryRefPrice: string
    decisionId: string | null
    commitTx: string | null
    recordTx: string | null
    failReason: string | null
    entryFillTx: string | null
    exitFillTx: string | null
    usdcSpent: number | null
    usdcReceived: number | null
    /** Something Flash did on its own, e.g. ended an order because the wallet was emptied. */
    flashNote?: string | null
  }[]
  predictions: {
    predictionId: string
    predictorKind: 'agent' | 'owner'
    predictorAddress: string
    side: 'YES' | 'NO'
    probYesBps: number
    decisionId: string | null
    predictTx: string | null
    brier: number | null
  }[]
  decisions: VerifyDecision[]
  contracts: { tradeLog: Address; arena: Address; usdc: Address }
}

export type VerifyStatus = 'pass' | 'fail' | 'skip'
export type VerifyStep = { id: string; label: string; status: VerifyStatus; detail: string }
export type VerifyReport = { ok: boolean; steps: VerifyStep[] }

export type VerifyOptions = {
  chainId: number
  /** Independent TEE re-check (0G SDK, Node only). Without it the router's flag is reported. */
  verifyTee?: (d: VerifyDecision) => Promise<boolean>
}

/** A trade commits just before its market opens, so its logs sit a little before the open tx. */
const COMMIT_LOOKBACK_BLOCKS = 1000n

/** Onchain USDC net flow may differ from the fills we stored by rounding, at most this much. */
export const FILL_TOLERANCE_BPS = 5

const OUTCOME = ['PENDING', 'YES', 'NO', 'VOID'] as const

class Skip extends Error {}

function must(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

type Pos = { blockNumber: bigint; transactionIndex: number }
const before = (a: Pos, b: Pos) =>
  a.blockNumber !== b.blockNumber
    ? a.blockNumber < b.blockNumber
    : a.transactionIndex < b.transactionIndex

/** Written on an intent when Flash itself ended an order for lack of funds in the wallet. */
export const FUNDS_DRAINED_NOTE = 'Flash cancelled the order: the wallet no longer held the funds'

/** Realized PnL rule from the resolver, recomputed from the bundle. */
export function expectedOutcome(intents: EntryBundle['intents']) {
  if (
    intents.some((i) =>
      ['DRAFT', 'COMMITTED', 'EXECUTING', 'RESTING', 'EXECUTED'].includes(i.state),
    )
  ) {
    const drained = intents.some((i) => i.flashNote === FUNDS_DRAINED_NOTE)
    return {
      outcome: 'VOID' as const,
      pnlBps: 0,
      pnl: 0,
      spent: 0,
      voidReason: drained ? 'funds_withdrawn' : 'unsettled_intent',
    }
  }
  const closed = intents.filter(
    (i) => i.state === 'CLOSED' && i.usdcSpent != null && i.usdcReceived != null,
  )
  if (!closed.length)
    return { outcome: 'VOID' as const, pnlBps: 0, pnl: 0, spent: 0, voidReason: 'no_trades' }
  const spent = closed.reduce((s, i) => s + i.usdcSpent!, 0)
  const pnl = closed.reduce((s, i) => s + (i.usdcReceived! - i.usdcSpent!), 0)
  return {
    outcome: pnl > 0 ? ('YES' as const) : ('NO' as const),
    pnlBps: spent > 0 ? Math.round((pnl * 10_000) / spent) : 0,
    pnl,
    spent,
    voidReason: null,
  }
}

export async function verifyEntry(
  b: EntryBundle,
  client: PublicClient,
  opts: VerifyOptions,
): Promise<VerifyReport> {
  const local = opts.chainId === LOCAL_CHAIN_ID
  const { entry, round, contracts } = b
  const trader = getAddress(b.trader.address)
  const resolved = entry.outcome !== 'PENDING'
  const receipts = new Map<string, Awaited<ReturnType<PublicClient['getTransactionReceipt']>>>()
  const receipt = async (hash: string) => {
    const hit = receipts.get(hash)
    if (hit) return hit
    const r = await client.getTransactionReceipt({ hash: hash as Hash })
    must(r.status === 'success', `tx ${hash} reverted`)
    receipts.set(hash, r)
    return r
  }
  const decision = (id: string | null) => b.decisions.find((d) => d.id === id)
  const committed = b.intents.filter((i) => i.commitTx)
  const executed = committed.filter((i) => i.state === 'EXECUTED' || i.state === 'CLOSED')

  // The log window of this entry: from just before its openEntry tx to its resolution (or now).
  const window = async () => {
    must(entry.openTx, 'entry has no open tx')
    const open = (await receipt(entry.openTx)).blockNumber
    return {
      fromBlock: open > COMMIT_LOOKBACK_BLOCKS ? open - COMMIT_LOOKBACK_BLOCKS : 0n,
      toBlock: entry.resolveTx
        ? (await receipt(entry.resolveTx)).blockNumber
        : await client.getBlockNumber(),
    }
  }
  const lockPos = async () => {
    must(round.lockTx, 'round has no lock tx')
    const r = await receipt(round.lockTx)
    const logs = parseEventLogs({ abi: arenaAbi, eventName: 'PredictionsLocked', logs: r.logs })
    must(
      logs.some(
        (l) => l.args.roundId === BigInt(round.id) && isAddressEqual(l.address, contracts.arena),
      ),
      'lock tx has no PredictionsLocked event for this round',
    )
    return r
  }

  const steps: VerifyStep[] = []
  async function check(id: string, label: string, run: () => Promise<string>) {
    try {
      steps.push({ id, label, status: 'pass', detail: await run() })
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      steps.push({ id, label, status: err instanceof Skip ? 'skip' : 'fail', detail })
    }
  }

  await check('entry-onchain', 'Entry matches Arena state', async () => {
    must(entry.onchainEntryId != null, 'entry has no onchain id')
    const [roundId, onchainTrader, outcome, pnlBps] = await client.readContract({
      address: contracts.arena,
      abi: arenaAbi,
      functionName: 'entries',
      args: [BigInt(entry.onchainEntryId)],
    })
    must(roundId === BigInt(entry.roundId), `round: onchain ${roundId}, claimed ${entry.roundId}`)
    must(isAddressEqual(onchainTrader, trader), `trader: onchain ${onchainTrader}`)
    must(
      OUTCOME[outcome] === entry.outcome,
      `outcome: onchain ${OUTCOME[outcome]}, claimed ${entry.outcome}`,
    )
    if (resolved)
      must(pnlBps === entry.pnlBps, `pnlBps: onchain ${pnlBps}, claimed ${entry.pnlBps}`)
    return `#${entry.onchainEntryId}: ${OUTCOME[outcome]}${resolved ? `, ${pnlBps} bps` : ''}`
  })

  await check('predictions-closed', 'Predictions closed onchain', async () => {
    if (!round.lockTx) throw new Skip('predictions not locked yet')
    const lock = await lockPos()
    must(
      await client.readContract({
        address: contracts.arena,
        abi: arenaAbi,
        functionName: 'roundLocked',
        args: [BigInt(round.id)],
      }),
      'round is not locked onchain',
    )
    const logs = await client.getLogs({
      address: contracts.arena,
      event: getAbiItem({ abi: arenaAbi, name: 'Predicted' }),
      args: { entryId: BigInt(entry.onchainEntryId ?? 0) },
      ...(await window()),
      strict: true,
    })
    must(
      logs.length === b.predictions.length,
      `${logs.length} predictions onchain, ${b.predictions.length} claimed`,
    )
    for (const log of logs) {
      must(before(log, lock), `prediction by ${log.args.predictor} landed after the lock`)
      const p = b.predictions.find((x) =>
        isAddressEqual(getAddress(x.predictorAddress), log.args.predictor),
      )
      must(p, `prediction by ${log.args.predictor} is missing from the claims`)
      must(
        p.side === (log.args.yes ? 'YES' : 'NO') && p.probYesBps === log.args.probYesBps,
        `prediction by ${log.args.predictor} differs from the onchain event`,
      )
      const d = decision(p.decisionId)
      const want = p.predictorKind === 'owner' ? zeroHash : d && idHash(d.requestId)
      must(
        want === log.args.zeroGRequestIdHash,
        `0G request id hash of ${log.args.predictor} differs from the onchain event`,
      )
    }
    return `${logs.length} prediction(s) in blocks before lock block ${lock.blockNumber}`
  })

  await check('no-self-prediction', 'Nobody predicted on their own agent', async () => {
    for (const p of b.predictions) {
      const same = await client.readContract({
        address: contracts.arena,
        abi: arenaAbi,
        functionName: 'sameHuman',
        args: [getAddress(p.predictorAddress), trader],
      })
      must(!same, `${p.predictorAddress} is the same human as the trader`)
    }
    return `${b.predictions.length} predictor(s) checked against the human registry`
  })

  await check('commits', 'Commits are complete and match their intents', async () => {
    const logs = await client.getLogs({
      address: contracts.tradeLog,
      event: getAbiItem({ abi: tradeLogAbi, name: 'IntentCommitted' }),
      args: { roundId: BigInt(entry.roundId), agent: trader },
      ...(await window()),
      strict: true,
    })
    must(
      logs.length === committed.length,
      `${logs.length} commit(s) onchain, ${committed.length} claimed`,
    )
    const open = committed.length ? await receipt(entry.openTx!) : undefined
    for (const i of committed) {
      must(
        canonicalHash(JSON.parse(i.canonicalJson)) === i.intentHash,
        `${i.intentId}: hash differs`,
      )
      must(
        keccak256(toBytes(i.canonicalJson)) === i.intentHash,
        `${i.intentId}: JSON not canonical`,
      )
      const c = JSON.parse(i.canonicalJson) as {
        roundId: number
        agentAddress: string
        asset: string
        side: string
        sizeQuote: string
        stopPrice: string
        targetPrice: string
        entryRefPrice: string
        zeroG: { requestId: string }
      }
      must(c.roundId === entry.roundId, `${i.intentId}: committed for round ${c.roundId}`)
      must(isAddressEqual(getAddress(c.agentAddress), trader), `${i.intentId}: wrong agent`)
      must(c.asset === 'WETH' && c.side === 'long', `${i.intentId}: not a long WETH trade`)
      must(
        Number(parseUnits(c.sizeQuote, USDC_DECIMALS)) === i.sizeQuote &&
          c.stopPrice === i.stopPrice &&
          c.targetPrice === i.targetPrice &&
          c.entryRefPrice === i.entryRefPrice,
        `${i.intentId}: stored parameters differ from what was committed`,
      )
      const log = logs.find((l) => l.args.intentHash === i.intentHash)
      must(log, `${i.intentId}: no IntentCommitted event`)
      must(log.transactionHash === i.commitTx, `${i.intentId}: commit tx differs`)
      must(
        log.args.zeroGRequestIdHash === idHash(c.zeroG.requestId),
        `${i.intentId}: 0G request id hash differs from the onchain commit`,
      )
      must(open && before(log, open), `${i.intentId}: market opened before the commit`)
    }
    return `${logs.length} commit(s), hashes recomputed, all before the market opened`
  })

  await check('terminal', 'Every commit ended as executed or failed', async () => {
    for (const i of committed) {
      if (['COMMITTED', 'EXECUTING'].includes(i.state) && !resolved)
        throw new Skip(`${i.intentId} still in flight`)
      must(i.recordTx, `${i.intentId}: no record tx`)
      const r = await receipt(i.recordTx)
      must(before(await receipt(i.commitTx!), r), `${i.intentId}: recorded before commit`)
      const logs = parseEventLogs({ abi: tradeLogAbi, logs: r.logs })
      if (i.state === 'FAILED') {
        must(
          logs.some((l) => l.eventName === 'IntentFailed' && l.args.intentHash === i.intentHash),
          `${i.intentId}: no IntentFailed event`,
        )
        continue
      }
      const done = logs.find(
        (l) => l.eventName === 'IntentExecuted' && l.args.intentHash === i.intentHash,
      )
      must(done?.eventName === 'IntentExecuted', `${i.intentId}: no IntentExecuted event`)
      must(done.args.fillTxHash === i.entryFillTx, `${i.intentId}: recorded fill tx differs`)
    }
    return `${committed.length} commit(s) closed onchain`
  })

  await check('commit-before-fill', 'Each commit landed before its fill', async () => {
    if (local) throw new Skip('local Flash stub: fills are fake, nothing onchain to compare')
    for (const i of executed) {
      must(i.entryFillTx, `${i.intentId}: no entry fill`)
      const fill = await receipt(i.entryFillTx)
      must(before(await receipt(i.commitTx!), fill), `${i.intentId}: filled before its commit`)
      must(before(fill, await receipt(entry.openTx!)), `${i.intentId}: market opened before fill`)
      if (i.state !== 'CLOSED') continue
      must(i.exitFillTx, `${i.intentId}: no exit fill`)
      must(before(fill, await receipt(i.exitFillTx)), `${i.intentId}: exit before entry`)
    }
    return `${executed.length} fill(s) after their commits, before the market opened`
  })

  await check('fills-onchain', 'USDC moved onchain matches the fills', async () => {
    if (local) throw new Skip('local Flash stub: fills are fake, no USDC moved')
    if (!executed.length) throw new Skip('no fills')
    if (!resolved) throw new Skip('entry not resolved yet')
    const first = (await Promise.all(executed.map((i) => receipt(i.commitTx!)))).reduce((a, r) =>
      r.blockNumber < a.blockNumber ? r : a,
    )
    const range = { fromBlock: first.blockNumber, toBlock: (await window()).toBlock }
    const transfer = getAbiItem({ abi: erc20Abi, name: 'Transfer' })
    const owner = getAddress(b.trader.owner)
    const [out, inc] = await Promise.all([
      client.getLogs({
        address: contracts.usdc,
        event: transfer,
        args: { from: trader },
        ...range,
        strict: true,
      }),
      client.getLogs({
        address: contracts.usdc,
        event: transfer,
        args: { to: trader },
        ...range,
        strict: true,
      }),
    ])
    // Owner deposits and withdrawals are not trading.
    const sum = (logs: typeof out, party: 'from' | 'to') =>
      logs
        .filter((l) => !isAddressEqual(l.args[party], owner))
        .reduce((s, l) => s + l.args.value, 0n)
    const net = Number(sum(inc, 'from') - sum(out, 'to'))
    const claimed = expectedOutcome(b.intents)
    const tolerance = Math.max(2, Math.ceil((claimed.spent * FILL_TOLERANCE_BPS) / 10_000))
    must(
      Math.abs(net - claimed.pnl) <= tolerance,
      `net USDC onchain ${net / 1e6}, fills claim ${claimed.pnl / 1e6}`,
    )
    return `net ${net / 1e6} USDC onchain, ${claimed.pnl / 1e6} USDC from fills`
  })

  await check('pnl', 'Outcome and PnL recomputed from fills', async () => {
    if (!resolved) throw new Skip('entry not resolved yet')
    const want = expectedOutcome(b.intents)
    must(entry.outcome === want.outcome, `outcome ${entry.outcome}, recomputed ${want.outcome}`)
    if (entry.outcome === 'VOID') {
      must(entry.voidReason === want.voidReason, `void reason ${entry.voidReason}`)
      return `VOID: ${want.voidReason}`
    }
    must(entry.pnlBps === want.pnlBps, `pnlBps ${entry.pnlBps}, recomputed ${want.pnlBps}`)
    return `${want.pnl / 1e6} USDC on ${want.spent / 1e6} spent = ${want.pnlBps} bps → ${want.outcome}`
  })

  await check('decisions', 'Every decision came from a sealed 0G model', async () => {
    const required = [
      ...committed.map((i) => i.decisionId),
      ...b.predictions.filter((p) => p.predictorKind === 'agent').map((p) => p.decisionId),
    ]
    const used = new Set<VerifyDecision>()
    for (const id of required) {
      const d = decision(id)
      must(d, `decision ${id} is missing`)
      must(d.accepted, `decision ${d.requestId} was rejected yet acted on`)
      used.add(d)
    }
    for (const i of committed) {
      const c = JSON.parse(i.canonicalJson) as { zeroG: { requestId: string; model: string } }
      const d = decision(i.decisionId)
      must(
        c.zeroG.requestId === d?.requestId && c.zeroG.model === d.model,
        `${i.intentId}: committed request id differs from its decision`,
      )
    }
    const list = [...used]
    if (local && list.every((d) => d.model === 'local-stub'))
      throw new Skip(`local model stub: ${list.length} decision(s), no TEE to check`)
    for (const d of list) {
      must(d.model !== 'local-stub', `decision ${d.requestId} used the local stub`)
      must(d.teeVerified === true, `decision ${d.requestId} is not TEE verified`)
      if (opts.verifyTee)
        must(await opts.verifyTee(d), `decision ${d.requestId} failed independent TEE verification`)
    }
    const how = opts.verifyTee ? 're-verified with the 0G SDK' : 'router-reported tee_verified'
    return `${list.length} decision(s), ${how}`
  })

  await check('brier', 'Brier scores recomputed', async () => {
    if (!resolved) throw new Skip('entry not resolved yet')
    // A prediction made once the exit had already filled saw the outcome: it can't be scored.
    const exits = local ? [] : b.intents.flatMap((i) => (i.exitFillTx ? [i.exitFillTx] : []))
    const exitBlocks = await Promise.all(exits.map(async (x) => (await receipt(x)).blockNumber))
    for (const p of b.predictions) {
      if (entry.outcome === 'VOID') {
        must(p.brier == null, `${p.predictionId}: scored on a VOID entry`)
        continue
      }
      if (exitBlocks.length) {
        must(p.predictTx, `${p.predictionId}: no prediction tx`)
        const at = (await receipt(p.predictTx)).blockNumber
        if (exitBlocks.some((e) => at >= e)) {
          must(p.brier == null, `${p.predictionId}: scored after the exit filled`)
          continue
        }
      }
      const y = entry.outcome === 'YES' ? 1 : 0
      const want = (p.probYesBps / 10_000 - y) ** 2
      must(p.brier != null && Math.abs(p.brier - want) < 1e-9, `${p.predictionId}: wrong Brier`)
    }
    return `${b.predictions.length} prediction(s)`
  })

  return { ok: steps.every((s) => s.status !== 'fail'), steps }
}
