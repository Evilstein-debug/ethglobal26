import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { cancelMessage } from '@starter/flash'
import { tradeLogAbi } from '@starter/shared/generated'
import { canonicalHash } from '@starter/shared/canonical'
import { eq } from 'drizzle-orm'
import type { Address, Hex } from 'viem'
import { schema } from '../db'
import { createAgent } from '../services/agents'
import { skipReason, startAnvilWorld } from '../test/anvil'
import { closePosition, syncExit } from './close'
import { executeTrade, newIntentId } from './trade'
import { governTwap } from './twap'
import { settleResting } from './resting'
import { reserveMarket, tickMarkets, type MarketConfig } from '../rounds/scheduler'

const policy = { perTradeCap: '5', dailyCap: '20' }

function intentFor(agent: Address, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    intentId: newIntentId(),
    roundId: 1,
    agentAddress: agent,
    asset: 'WETH',
    side: 'long',
    entryRefPrice: '3000',
    sizeQuote: '3',
    orderType: 'bracket',
    stopPrice: '2950',
    targetPrice: '3060',
    rationale: 'test',
    zeroG: { requestId: `req-${Math.random()}`, model: 'manual' },
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}
const twapPlan = { style: 'twap', durationSeconds: 300, buckets: 3 }
const limitPlan = { style: 'limit', limitPrice: '2970', expireSeconds: 600 }
/** A limit buy 1% under the 3000 market, with the bracket measured from the limit. */
const limitOverrides = { execution: limitPlan, stopPrice: '2925', targetPrice: '3030' }
const marketCfg: MarketConfig = {
  predictionWindowMs: 60_000,
  maxHoldMs: 600_000,
  thinkEveryMs: 0,
  minGasWei: 1n,
  closeGraceMs: 30_000,
  epochMs: 3_600_000,
  epoch: { budget: 5_000_000, minEntries: 1, minPredictions: 1 },
}

async function setup() {
  const world = await startAnvilWorld()
  const bob = await world.owner(`bob${Math.random().toString(36).slice(2, 8)}`)
  const view = await createAgent(world.ctx, bob.wallet, { name: 'Alpha', mode: 'trade', policy })
  const agent = view.address as Address
  await world.fund(agent, '20', '0.05')
  const onchain = async (intentHash: Hex) => {
    const [, , , status] = await world.publicClient.readContract({
      address: world.contracts.tradeLog,
      abi: tradeLogAbi,
      functionName: 'intents',
      args: [intentHash],
    })
    return ['None', 'Committed', 'Executed', 'Failed'][status]
  }
  const intentRow = async (intentId: string) =>
    (
      await world.ctx.db.select().from(schema.intents).where(eq(schema.intents.intentId, intentId))
    )[0]!
  /** A market and entry for the trade, so predictors can vote on it. */
  async function openMarket(intentId: string, votes: number[]) {
    const row = await intentRow(intentId)
    await world.ctx.db
      .insert(schema.rounds)
      .values({ id: row.roundId, phase: 'PREDICTING', epochId: 0, startsAt: 0, phaseEndsAt: 0 })
      .onConflictDoNothing()
    const [entry] = await world.ctx.db
      .insert(schema.roundEntries)
      .values({
        roundId: row.roundId,
        traderAgentId: row.agentId,
        policySnapshot: '{}',
        policySnapshotHash: '0x',
        tradeBudget: row.sizeQuote,
      })
      .returning()
    await world.ctx.db
      .update(schema.intents)
      .set({ entryId: entry!.id })
      .where(eq(schema.intents.intentId, intentId))
    for (const [i, probYesBps] of votes.entries()) {
      await world.ctx.db.insert(schema.predictions).values({
        predictionId: `p-${intentId}-${i}`,
        roundId: row.roundId,
        entryId: entry!.id,
        predictorKind: 'owner',
        predictorAddress: `0x${String(i).padStart(40, '0')}`,
        side: probYesBps >= 5000 ? 'YES' : 'NO',
        probYesBps,
        canonicalJson: '{}',
        createdAt: Date.now(),
      })
    }
    return entry!.id
  }
  return { ...world, agent, agentId: view.id, onchain, intentRow, openMarket }
}

describe('Flash features on anvil', { skip: skipReason }, () => {
  test('risk guard: a flagged asset is refused before anything is reserved, committed or sent', async () => {
    const { ctx, agent, stub, agentId } = await setup()
    stub.riskFlagged = true
    const res = await executeTrade(ctx, intentFor(agent))
    assert.deepEqual(res, { status: 'denied', reason: 'asset_risk_flagged' })
    assert.equal(stub.submitted.length, 0)
    assert.equal((await ctx.db.select().from(schema.intents)).length, 0)
    assert.equal(
      (
        await ctx.db
          .select()
          .from(schema.spendLedger)
          .where(eq(schema.spendLedger.agentId, agentId))
      ).length,
      0,
    )
  })

  test('risk guard: no answer from Flash is not a yes', async () => {
    const { ctx, agent, stub } = await setup()
    ctx.flash!.api.search = async () => {
      throw new Error('Flash is down')
    }
    const res = await executeTrade(ctx, intentFor(agent))
    assert.deepEqual(res, { status: 'denied', reason: 'asset_check_failed' })
    assert.equal(stub.submitted.length, 0)
  })

  test('quote race: signs the newest quote and records how the price moved', async () => {
    const { ctx, agent, stub, intentRow } = await setup()
    ctx.flash!.quoteWindowMs = 700
    const intent = intentFor(agent)
    setTimeout(() => stub.setPrice(2900), 100) // cheaper while we listen → more WETH out
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'executed', JSON.stringify(res))
    const row = await intentRow(intent.intentId)
    assert.ok((row.quoteRevisions ?? 0) > 1, `revisions: ${row.quoteRevisions}`)
    assert.ok(Number(row.quoteFinalOut) > Number(row.quoteFirstOut))
  })

  test('quote race: a broken stream falls back to a plain quote and the trade still goes through', async () => {
    const { ctx, agent, intentRow } = await setup()
    ctx.flash!.quoteWindowMs = 100
    ctx.flash!.api.openQuoteStream = async () => {
      throw new Error('socket closed')
    }
    const intent = intentFor(agent)
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'executed', JSON.stringify(res))
    assert.equal((await intentRow(intent.intentId)).quoteRevisions, null)
  })

  test('TWAP: commits its schedule, then the first tranche opens the position', async () => {
    const { ctx, agent, agentId, stub, onchain, intentRow } = await setup()
    const intent = intentFor(agent, { execution: twapPlan })
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'executed', JSON.stringify(res))
    if (res.status !== 'executed') return
    // The schedule is part of what was hashed and committed before any order was sent.
    assert.equal(res.intentHash, canonicalHash(intent))
    assert.equal(await onchain(res.intentHash), 'Executed')
    const row = await intentRow(intent.intentId)
    assert.equal(row.entryStyle, 'twap')
    assert.equal(row.twapBuckets, 3)
    assert.equal(row.usdcSpent, 1_000_000, 'one tranche of three has filled')
    const order = (await stub.getOrder(res.flashOrderId, agent)).order
    assert.equal(order.status, 'ORDER_STATUS_PARTIALLY_FILLED')
    assert.equal(order.completedFillCount, 1)
    assert.ok(res.bracketOrderId, 'the bracket is live from the first fill')
    // The whole plan stays reserved while tranches are still to come.
    const [ledger] = await ctx.db
      .select()
      .from(schema.spendLedger)
      .where(eq(schema.spendLedger.agentId, agentId))
    assert.equal(ledger!.amount, 3_000_000)
    assert.equal(ledger!.status, 'settled')
  })

  test('TWAP: a bullish crowd lets the rest of the tranches run to the end', async () => {
    const { ctx, agent, stub, advance, intentRow, openMarket } = await setup()
    const intent = intentFor(agent, { execution: twapPlan })
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'executed')
    if (res.status !== 'executed') return
    await openMarket(intent.intentId, [7000, 6500])
    assert.equal(await governTwap(ctx, intent.intentId), 'skipped', 'not due yet')
    advance(110_000) // one interval (300s / 3)
    assert.equal(await governTwap(ctx, intent.intentId), 'continued')
    assert.equal((await stub.getOrder(res.flashOrderId, agent)).order.completedFillCount, 2)
    advance(400_000)
    assert.equal((await stub.getOrder(res.flashOrderId, agent)).order.status, 'ORDER_STATUS_FILLED')
    assert.equal(await governTwap(ctx, intent.intentId), 'finished')
    assert.equal((await intentRow(intent.intentId)).twapNextCheckAt, null)
    const feed = await ctx.db.select().from(schema.agentActivity)
    assert.ok(feed.some((f) => f.state === 'twap' && /rest goes ahead/.test(f.message)))
  })

  test('TWAP: a bearish crowd cancels the rest; the position keeps only what filled and closes', async () => {
    const { ctx, agent, stub, advance, intentRow, openMarket } = await setup()
    const intent = intentFor(agent, { execution: twapPlan })
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'executed')
    if (res.status !== 'executed') return
    await openMarket(intent.intentId, [3000, 4000, 4500])
    advance(110_000)
    assert.equal(await governTwap(ctx, intent.intentId), 'trimmed')
    advance(1_000_000) // time passes; nothing more may fill
    const order = (await stub.getOrder(res.flashOrderId, agent)).order
    assert.equal(order.status, 'ORDER_STATUS_CANCELLED')
    assert.equal(order.completedFillCount, 2)
    const feed = await ctx.db.select().from(schema.agentActivity)
    assert.ok(feed.some((f) => f.state === 'twap' && /cancelled the remaining 1/.test(f.message)))

    // Closing sells what was built and costs what actually filled, not what was planned.
    const closed = await closePosition(ctx, intent.intentId)
    assert.equal(closed.status, 'closed', JSON.stringify(closed))
    const row = await intentRow(intent.intentId)
    assert.equal(row.state, 'CLOSED')
    assert.equal(row.usdcSpent, 2_000_000)
    assert.ok((row.usdcReceived ?? 0) > 1_900_000 && (row.usdcReceived ?? 0) < 2_000_000)
  })

  test('TWAP: with too few predictors the crowd cannot trim', async () => {
    const { ctx, agent, advance, openMarket } = await setup()
    const intent = intentFor(agent, { execution: twapPlan })
    assert.equal((await executeTrade(ctx, intent)).status, 'executed')
    await openMarket(intent.intentId, [])
    advance(110_000)
    assert.equal(await governTwap(ctx, intent.intentId), 'waiting')
  })

  test('TWAP: a bracket leg that fires stops the remaining tranches', async () => {
    const { ctx, agent, stub, intentRow } = await setup()
    const intent = intentFor(agent, { execution: twapPlan })
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'executed')
    if (res.status !== 'executed') return
    stub.setPrice(3100) // take-profit crossed
    const closed = await syncExit(ctx, intent.intentId)
    assert.equal(closed?.status, 'closed')
    const order = (await stub.getOrder(res.flashOrderId, agent)).order
    assert.equal(order.status, 'ORDER_STATUS_CANCELLED')
    assert.equal(order.completedFillCount, 1)
    assert.equal((await intentRow(intent.intentId)).usdcSpent, 1_000_000)
  })

  test('TWAP: one that never fills is cancelled, not left running', async () => {
    const { ctx, agent, stub, onchain } = await setup()
    ctx.flash!.fillTimeoutMs = 200
    const realGet = stub.getOrder.bind(stub)
    // Flash accepts the order but never reports a fill.
    ctx.flash!.api.getOrder = async (id, funder) => {
      const r = await realGet(id, funder)
      return { order: { ...r.order, completedFillCount: 0, attachedBracket: null }, fills: [] }
    }
    const intent = intentFor(agent, { execution: twapPlan })
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'failed')
    assert.equal(res.status === 'failed' && res.reason, 'fill_timeout')
    assert.equal(await onchain(canonicalHash(intent)), 'Failed')
    ctx.flash!.api.getOrder = realGet
    const id = stub.submitted[0]!.orderId
    assert.equal((await stub.getOrder(id, agent)).order.status, 'ORDER_STATUS_CANCELLED')
  })

  test('drained wallet: Flash ending the entry order is recorded as its own failure', async () => {
    const { ctx, agent, agentId, onchain, intentRow } = await setup()
    const realGet = ctx.flash!.api.getOrder.bind(ctx.flash!.api)
    ctx.flash!.api.getOrder = async (id, funder) => {
      const r = await realGet(id, funder)
      return {
        ...r,
        order: {
          ...r.order,
          status: 'ORDER_STATUS_CANCELLED',
          closeReason: 'REASON_INSUFFICIENT_FUNDER_BALANCE',
        },
        fills: [],
      }
    }
    const intent = intentFor(agent)
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'failed')
    assert.equal(res.status === 'failed' && res.reason, 'funds_drained')
    assert.equal(await onchain(canonicalHash(intent)), 'Failed')
    assert.match((await intentRow(intent.intentId)).flashNote ?? '', /no longer held the funds/)
    const [ledger] = await ctx.db
      .select()
      .from(schema.spendLedger)
      .where(eq(schema.spendLedger.agentId, agentId))
    assert.equal(ledger!.status, 'released')
  })

  test('drained wallet: a bracket Flash cancelled on its own is noted once, and the position can still be sold', async () => {
    const { ctx, agent, stub, intentRow } = await setup()
    const intent = intentFor(agent)
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'executed')
    if (res.status !== 'executed') return
    stub.forceCancel(res.bracketOrderId!, 'REASON_INSUFFICIENT_FUNDER_BALANCE')
    assert.equal(await syncExit(ctx, intent.intentId), null)
    assert.equal(await syncExit(ctx, intent.intentId), null)
    assert.match((await intentRow(intent.intentId)).flashNote ?? '', /no longer held the funds/)
    const feed = (await ctx.db.select().from(schema.agentActivity)).filter(
      (f) => f.state === 'flash',
    )
    assert.equal(feed.length, 1, 'said once, not on every tick')
    const closed = await closePosition(ctx, intent.intentId)
    assert.equal(closed.status === 'closed' && closed.via, 'market')
  })

  test('the cancel message used for a TWAP is the single-order message the signer allows', async () => {
    const { ctx, agent, advance, openMarket } = await setup()
    const intent = intentFor(agent, { execution: twapPlan })
    assert.equal((await executeTrade(ctx, intent)).status, 'executed')
    await openMarket(intent.intentId, [2000])
    advance(110_000)
    // governTwap signs through the agent signer; if the egress allowlist refused it this would throw.
    assert.equal(await governTwap(ctx, intent.intentId), 'trimmed')
    assert.match(cancelMessage('6bdb29aa-1b2c-4d3e-8f90-123456789abc'), /Cancel Order/)
  })

  test('limit: the order rests, nothing is announced, and the budget stays held', async () => {
    const { ctx, agent, agentId, stub, onchain, intentRow } = await setup()
    const intent = intentFor(agent, limitOverrides)
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'resting', JSON.stringify(res))
    if (res.status !== 'resting') return
    assert.equal(res.intentHash, canonicalHash(intent), 'the level is part of what was committed')
    assert.equal(await onchain(res.intentHash), 'Committed', 'committed, not yet executed')
    const row = await intentRow(intent.intentId)
    assert.equal(row.state, 'RESTING')
    assert.equal(row.entryStyle, 'limit')
    assert.equal(row.limitPrice, '2970.00'.replace('.00', ''))
    assert.ok(row.restingUntil && row.restingUntil > Date.now())
    const order = await stub.getOrder(res.flashOrderId, agent)
    assert.equal(order.order.status, 'ORDER_STATUS_ACCEPTED')
    assert.equal(order.fills.length, 0)
    const [ledger] = await ctx.db
      .select()
      .from(schema.spendLedger)
      .where(eq(schema.spendLedger.agentId, agentId))
    assert.equal(ledger!.status, 'reserved')
  })

  test('limit: while the price stays above the level, nothing happens', async () => {
    const { ctx, agent, stub, advance, onchain, intentRow } = await setup()
    const intent = intentFor(agent, limitOverrides)
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'resting')
    if (res.status !== 'resting') return
    stub.setPrice(2990)
    assert.equal(await settleResting(ctx, intent.intentId), 'waiting')
    advance(9_000)
    stub.setPrice(2980)
    assert.equal(await settleResting(ctx, intent.intentId), 'waiting')
    assert.equal((await intentRow(intent.intentId)).state, 'RESTING')
    assert.equal(await onchain(res.intentHash), 'Committed')
  })

  test('limit: the dip fills it; the fill is recorded onchain and the bracket goes live', async () => {
    const { ctx, agent, agentId, stub, onchain, intentRow } = await setup()
    const intent = intentFor(agent, limitOverrides)
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'resting')
    if (res.status !== 'resting') return
    stub.setPrice(2960)
    assert.equal(await settleResting(ctx, intent.intentId), 'filled')
    assert.equal(await onchain(res.intentHash), 'Executed')
    const row = await intentRow(intent.intentId)
    assert.equal(row.state, 'EXECUTED')
    assert.equal(row.restingUntil, null)
    assert.equal(row.usdcSpent, 3_000_000)
    assert.ok(row.entryFillTx && row.flashBracketOrderId)
    const [ledger] = await ctx.db
      .select()
      .from(schema.spendLedger)
      .where(eq(schema.spendLedger.agentId, agentId))
    assert.equal(ledger!.status, 'settled')
    const fill = (await stub.getOrder(res.flashOrderId, agent)).fills[0]!
    assert.ok(Number(fill.fillPrice) <= 2970, 'filled at the limit or better')
    const feed = await ctx.db.select().from(schema.agentActivity)
    assert.ok(feed.some((f) => f.state === 'flash' && /Limit buy filled/.test(f.message)))
    // Now it is an ordinary open position: the bracket can fire and close it.
    stub.setPrice(3040)
    const closed = await syncExit(ctx, intent.intentId)
    assert.equal(closed?.status, 'closed')
  })

  test('limit: it expires unfilled, which is recorded as a failure and the budget is released', async () => {
    const { ctx, agent, agentId, advance, onchain, intentRow } = await setup()
    const intent = intentFor(agent, limitOverrides)
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'resting')
    if (res.status !== 'resting') return
    advance(601_000)
    assert.equal(await settleResting(ctx, intent.intentId), 'failed')
    assert.equal(await onchain(res.intentHash), 'Failed')
    const row = await intentRow(intent.intentId)
    assert.equal(row.state, 'FAILED')
    assert.match(row.failReason ?? '', /^never_filled/)
    const [ledger] = await ctx.db
      .select()
      .from(schema.spendLedger)
      .where(eq(schema.spendLedger.agentId, agentId))
    assert.equal(ledger!.status, 'released')
    const feed = await ctx.db.select().from(schema.agentActivity)
    assert.ok(feed.some((f) => /expired unfilled/.test(f.message)))
  })

  test('limit: if Flash does not expire it, we cancel it ourselves with a signed message', async () => {
    const { ctx, agent, stub, onchain, intentRow } = await setup()
    const intent = intentFor(agent, limitOverrides)
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'resting')
    if (res.status !== 'resting') return
    // Our own deadline passes while the order is still live at Flash.
    await ctx.db
      .update(schema.intents)
      .set({ restingUntil: Date.now() - 1_000 })
      .where(eq(schema.intents.intentId, intent.intentId))
    assert.equal(await settleResting(ctx, intent.intentId), 'failed')
    assert.equal(
      (await stub.getOrder(res.flashOrderId, agent)).order.closeReason,
      'REASON_USER_REQUESTED',
    )
    assert.equal(await onchain(res.intentHash), 'Failed')
    assert.equal((await intentRow(intent.intentId)).state, 'FAILED')
    stub.setPrice(2000) // a cancelled order never fills
    assert.equal((await stub.getOrder(res.flashOrderId, agent)).fills.length, 0)
  })

  test('limit: a failed record is retried, so a commit is never left hanging', async () => {
    const { ctx, agent, stub, advance, onchain, intentRow } = await setup()
    const intent = intentFor(agent, limitOverrides)
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'resting')
    if (res.status !== 'resting') return
    stub.setPrice(2960)
    // The order has filled at Flash, but the agent cannot send the record (no gas).
    const keep = ctx.publicClient.waitForTransactionReceipt.bind(ctx.publicClient)
    let fail = true
    ctx.publicClient.waitForTransactionReceipt = (async (a: never) => {
      if (fail) throw new Error('rpc timeout')
      return keep(a)
    }) as typeof ctx.publicClient.waitForTransactionReceipt
    assert.equal(await settleResting(ctx, intent.intentId), 'waiting')
    assert.equal((await intentRow(intent.intentId)).state, 'RESTING')
    fail = false
    // The first attempt's transaction did go out; in real life the retry comes seconds later.
    await new Promise((r) => setTimeout(r, 500))
    advance(9_000)
    assert.equal(await settleResting(ctx, intent.intentId), 'filled')
    assert.equal(await onchain(res.intentHash), 'Executed')
  })

  test('limit: the market opens only after the fill, then predictors can act', async () => {
    const { ctx, agent, stub, advance, db } = await setup()
    const market = await reserveMarket(ctx, marketCfg)
    const intent = intentFor(agent, { ...limitOverrides, roundId: market.id })
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'resting')

    await tickMarkets(ctx, marketCfg)
    const phase = async () =>
      (await db.select().from(schema.rounds).where(eq(schema.rounds.id, market.id)))[0]!.phase
    assert.equal(await phase(), 'OPENING', 'still waiting: nothing announced')
    assert.equal((await db.select().from(schema.roundEntries)).length, 0)

    stub.setPrice(2960)
    advance(9_000)
    await tickMarkets(ctx, marketCfg)
    assert.equal(await phase(), 'PREDICTING')
    const entries = await db.select().from(schema.roundEntries)
    assert.equal(entries.length, 1)
    assert.equal(entries[0]!.tradeBudget, 3_000_000)
  })

  test('limit: one that never fills settles its market as empty, with no entry', async () => {
    const { ctx, agent, advance, db } = await setup()
    const market = await reserveMarket(ctx, marketCfg)
    const res = await executeTrade(ctx, intentFor(agent, { ...limitOverrides, roundId: market.id }))
    assert.equal(res.status, 'resting')
    advance(601_000)
    await tickMarkets(ctx, marketCfg) // settles the intent as failed
    await tickMarkets(ctx, marketCfg) // and the market with it
    const [m] = await db.select().from(schema.rounds).where(eq(schema.rounds.id, market.id))
    assert.equal(m!.phase, 'SETTLED')
    assert.equal((await db.select().from(schema.roundEntries)).length, 0)
  })

  test('limit: while one rests, the agent cannot start a second trade', async () => {
    const { ctx, agent } = await setup()
    assert.equal((await executeTrade(ctx, intentFor(agent, limitOverrides))).status, 'resting')
    const second = await executeTrade(ctx, intentFor(agent))
    assert.deepEqual(second, { status: 'denied', reason: 'position_open' })
  })
})
