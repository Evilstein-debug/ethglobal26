import assert from 'node:assert/strict'
import { test } from 'node:test'
import { eq } from 'drizzle-orm'
import { freshDb, schema, seedAgent } from '../db/testing'
import {
  authorizePrediction,
  authorizeTrade,
  releaseReservation,
  settleReservation,
} from './authorize'

const USDC = (n: number) => n * 1_000_000
const BIG = 1_000_000_000n
const trade = (
  agentId: string,
  amount: number,
  extra: Partial<{ roundId: number; asset: string }> = {},
) => ({
  agentId,
  roundId: extra.roundId ?? 1,
  amount,
  asset: extra.asset ?? 'WETH',
  ref: `intent-${Math.random()}`,
})

test('a valid trade reserves budget', async () => {
  const db = await freshDb()
  const { agentId } = await seedAgent(db)
  const auth = await authorizeTrade(db, trade(agentId, USDC(5)), BIG)
  assert.equal(auth.ok, true)
  const rows = await db.select().from(schema.spendLedger)
  assert.equal(rows.length, 1)
  assert.equal(rows[0]!.status, 'reserved')
  assert.equal(rows[0]!.amount, USDC(5))
})

test('every deny reason', async () => {
  const db = await freshDb()
  const { agentId } = await seedAgent(db, { perTradeCap: USDC(5), dailyCap: USDC(8) })
  const { agentId: predictor } = await seedAgent(db, { mode: 'predict' })

  const reasons = async (req: ReturnType<typeof trade>, balance = BIG) => {
    const r = await authorizeTrade(db, req, balance)
    return r.ok ? 'ok' : r.reason
  }
  assert.equal(await reasons(trade('nope', 1)), 'unknown_agent')
  assert.equal(await reasons(trade(agentId, 0)), 'invalid_amount')
  assert.equal(await reasons(trade(agentId, 1.5)), 'invalid_amount')
  assert.equal(await reasons(trade(predictor, 1)), 'mode_not_trader')
  assert.equal(await reasons(trade(agentId, 1, { asset: 'PEPE' })), 'asset_not_allowed')
  assert.equal(await reasons(trade(agentId, USDC(5) + 1)), 'over_trade_cap')
  assert.equal(await reasons(trade(agentId, USDC(1)), 999_999n), 'insufficient_funds')

  const first = await authorizeTrade(db, trade(agentId, USDC(5)), BIG)
  assert.ok(first.ok)
  assert.equal(await reasons(trade(agentId, 1, { roundId: 2 })), 'position_open')
  await settleReservation(db, first.reservationId)
  assert.equal(await reasons(trade(agentId, USDC(4), { roundId: 2 })), 'over_daily_cap') // 5 + 4 > 8

  await db.update(schema.policies).set({ paused: true }).where(eq(schema.policies.agentId, agentId))
  assert.equal(await reasons(trade(agentId, 1, { roundId: 3 })), 'paused')
  await db
    .update(schema.policies)
    .set({ paused: false })
    .where(eq(schema.policies.agentId, agentId))
  await db.update(schema.agents).set({ status: 'paused' }).where(eq(schema.agents.id, agentId))
  assert.equal(await reasons(trade(agentId, 1, { roundId: 3 })), 'paused')
})

test('allowlist is per agent, and only within TRADE_ASSETS', async () => {
  const db = await freshDb()
  const { agentId } = await seedAgent(db)
  await db
    .update(schema.policies)
    .set({ tokenAllowlist: '["PEPE"]' })
    .where(eq(schema.policies.agentId, agentId))
  const pepe = await authorizeTrade(db, trade(agentId, 1, { asset: 'PEPE' }), BIG)
  assert.deepEqual(pepe, { ok: false, reason: 'asset_not_allowed' })
  await db
    .update(schema.policies)
    .set({ tokenAllowlist: '[]' })
    .where(eq(schema.policies.agentId, agentId))
  assert.deepEqual(await authorizeTrade(db, trade(agentId, 1), BIG), {
    ok: false,
    reason: 'asset_not_allowed',
  })
})

test('released budget is reusable; settled budget counts', async () => {
  const db = await freshDb()
  const { agentId } = await seedAgent(db, { perTradeCap: USDC(5), dailyCap: USDC(5) })
  const first = await authorizeTrade(db, trade(agentId, USDC(5)), BIG)
  assert.ok(first.ok)
  await releaseReservation(db, first.reservationId)
  const second = await authorizeTrade(db, trade(agentId, USDC(5)), BIG)
  assert.ok(second.ok)
  await settleReservation(db, second.reservationId, USDC(4))
  // settled 4 of a 5 cap → 1 USDC left today
  assert.equal((await authorizeTrade(db, trade(agentId, USDC(1)), BIG)).ok, true)
  await assert.rejects(releaseReservation(db, first.reservationId), /not open/)
  await assert.rejects(settleReservation(db, second.reservationId), /not open/)
})

test('settle rejects amounts above the reservation', async () => {
  const db = await freshDb()
  const { agentId } = await seedAgent(db)
  const r = await authorizeTrade(db, trade(agentId, USDC(2)), BIG)
  assert.ok(r.ok)
  await assert.rejects(settleReservation(db, r.reservationId, USDC(3)), /outside/)
})

test('reservation race: one agent can only open one position', async () => {
  const db = await freshDb()
  const { agentId } = await seedAgent(db, { perTradeCap: USDC(1), dailyCap: USDC(100) })
  const results = await Promise.all(
    Array.from({ length: 20 }, () => authorizeTrade(db, trade(agentId, USDC(1)), BIG)),
  )
  assert.equal(results.filter((r) => r.ok).length, 1)
  assert.equal((await db.select().from(schema.spendLedger)).length, 1)
})

test('an unclosed intent blocks the next trade until it closes', async () => {
  const db = await freshDb()
  const { agentId } = await seedAgent(db)
  const open = await authorizeTrade(db, trade(agentId, USDC(1)), BIG)
  assert.ok(open.ok)
  await settleReservation(db, open.reservationId)
  await db.insert(schema.intents).values({
    intentId: 'i1',
    roundId: 1,
    agentId,
    canonicalJson: '{}',
    intentHash: '0x1',
    state: 'EXECUTED',
    asset: 'WETH',
    sizeQuote: USDC(1),
    entryRefPrice: '3000',
    stopPrice: '2950',
    targetPrice: '3060',
  })
  assert.deepEqual(await authorizeTrade(db, trade(agentId, 1), BIG), {
    ok: false,
    reason: 'position_open',
  })
  await db.update(schema.intents).set({ state: 'CLOSED' }).where(eq(schema.intents.intentId, 'i1'))
  assert.equal((await authorizeTrade(db, trade(agentId, 1), BIG)).ok, true)
})

test('the cooldown spaces out trades, even after a failed one', async () => {
  const db = await freshDb()
  const { agentId } = await seedAgent(db)
  const t0 = Date.now()
  const opts = { cooldownMs: 60_000 }
  const first = await authorizeTrade(db, trade(agentId, 1), BIG, t0, opts)
  assert.ok(first.ok)
  await releaseReservation(db, first.reservationId)
  assert.deepEqual(await authorizeTrade(db, trade(agentId, 1), BIG, t0 + 59_000, opts), {
    ok: false,
    reason: 'cooldown',
  })
  assert.equal((await authorizeTrade(db, trade(agentId, 1), BIG, t0 + 60_000, opts)).ok, true)
})

test('the daily cap is a rolling 24h window', async () => {
  const db = await freshDb()
  const { agentId } = await seedAgent(db, { perTradeCap: USDC(5), dailyCap: USDC(5) })
  const t0 = Date.now()
  const spent = await authorizeTrade(db, trade(agentId, USDC(5), { roundId: 1 }), BIG, t0)
  assert.ok(spent.ok)
  await settleReservation(db, spent.reservationId)
  const sameDay = await authorizeTrade(db, trade(agentId, 1, { roundId: 2 }), BIG, t0 + 1000)
  assert.deepEqual(sameDay, { ok: false, reason: 'over_daily_cap' })
  const nextDay = await authorizeTrade(
    db,
    trade(agentId, 1, { roundId: 3 }),
    BIG,
    t0 + 24 * 3600_000 + 1,
  )
  assert.equal(nextDay.ok, true)
})

async function seedRound(
  db: Awaited<ReturnType<typeof freshDb>>,
  traderAgentId: string,
  phase: 'PREDICTING' | 'TRADING' = 'PREDICTING',
) {
  await db
    .insert(schema.rounds)
    .values({ id: 1, phase, epochId: 1, startsAt: 0, phaseEndsAt: Date.now() + 600_000 })
    .onConflictDoNothing()
  const [entry] = await db
    .insert(schema.roundEntries)
    .values({
      roundId: 1,
      traderAgentId,
      policySnapshot: '{}',
      policySnapshotHash: '0x',
      tradeBudget: 1,
    })
    .returning()
  return entry!.id
}

test('predictions: gates and the same-human rule', async () => {
  const db = await freshDb()
  const bob = await seedAgent(db, { human: 'b0b', mode: 'trade' })
  const bobPredictor = await seedAgent(db, { human: 'b0b', mode: 'predict' })
  const alice = await seedAgent(db, { human: 'a11ce', mode: 'predict', predictionsPerDay: 1 })
  const traderOnly = await seedAgent(db, { human: 'c0de', mode: 'trade' })
  const entryId = await seedRound(db, bob.agentId)

  const reason = async (agentId: string, id = entryId) => {
    const r = await authorizePrediction(db, { agentId, entryId: id })
    return r.ok ? 'ok' : r.reason
  }
  assert.equal(bobPredictor.ownerWallet, bob.ownerWallet, 'same human, same owner row')
  assert.equal(await reason(bobPredictor.agentId), 'own_agent_entry')
  assert.equal(await reason(traderOnly.agentId), 'mode_not_predictor')
  assert.equal(await reason('ghost'), 'unknown_agent')
  assert.equal(await reason(alice.agentId, 999), 'unknown_entry')
  assert.equal(await reason(alice.agentId), 'ok')

  await db.insert(schema.predictions).values({
    predictionId: 'p1',
    roundId: 1,
    entryId,
    predictorKind: 'agent',
    predictorAddress: '0xalice',
    agentId: alice.agentId,
    side: 'YES',
    probYesBps: 6000,
    canonicalJson: '{}',
    createdAt: Date.now(),
  })
  assert.equal(await reason(alice.agentId), 'already_predicted')

  const otherTrader = await seedAgent(db, { human: 'd00d', mode: 'trade' })
  const [entry2] = await db
    .insert(schema.roundEntries)
    .values({
      roundId: 1,
      traderAgentId: otherTrader.agentId,
      policySnapshot: '{}',
      policySnapshotHash: '0x',
      tradeBudget: 1,
    })
    .returning()
  assert.equal(await reason(alice.agentId, entry2!.id), 'over_prediction_limit')

  await db.update(schema.rounds).set({ phaseEndsAt: 1 }).where(eq(schema.rounds.id, 1)) // expired
  assert.equal(await reason(bobPredictor.agentId, entry2!.id), 'predictions_closed')
  await db
    .update(schema.rounds)
    .set({ phase: 'TRADING', phaseEndsAt: Date.now() + 600_000 })
    .where(eq(schema.rounds.id, 1))
  assert.equal(await reason(bobPredictor.agentId, entry2!.id), 'predictions_closed')
})
