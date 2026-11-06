/**
 * Policy engine: the gate in front of the signer. Trade budgets are reserved atomically before
 * anything is signed (settled on fill, released on failure), so concurrent trades can't overspend.
 * Every denial returns a machine-readable reason the UI shows as-is.
 *
 * Limits come from the owner's policy row; the model never sets them.
 */
import { randomUUID } from 'node:crypto'
import { and, count, eq, gte, inArray, sql } from 'drizzle-orm'
import { TRADE_ASSETS } from '@starter/shared/tokens'
import { queryRows, schema, type Db } from '../db'

export type TradeDenyReason =
  | 'unknown_agent'
  | 'paused'
  | 'mode_not_trader'
  | 'invalid_amount'
  | 'asset_not_allowed'
  | 'over_trade_cap'
  | 'position_open'
  | 'cooldown'
  | 'over_daily_cap'
  | 'insufficient_funds'

export type PredictionDenyReason =
  | 'unknown_agent'
  | 'paused'
  | 'mode_not_predictor'
  | 'unknown_entry'
  | 'predictions_closed'
  | 'own_agent_entry'
  | 'already_predicted'
  | 'over_prediction_limit'

export type Denied<R> = { ok: false; reason: R }
export type TradeAuth = { ok: true; reservationId: string } | Denied<TradeDenyReason>
export type PredictionAuth = { ok: true } | Denied<PredictionDenyReason>

export type TradeRequest = {
  agentId: string
  roundId: number
  /** USDC base units (6 decimals). */
  amount: number
  asset: string
  /** intents.intent_id this reservation backs. */
  ref: string
}

const DAY_MS = 24 * 60 * 60 * 1000
const ACTIVE = sql`status in ('reserved', 'settled')`

export async function authorizeTrade(
  db: Db,
  req: TradeRequest,
  /** Fresh on-chain USDC balance of the agent wallet (base units). */
  usdcBalance: bigint,
  now = Date.now(),
  opts: {
    /** Check only: run every rule but reserve nothing (the owner's "would this trade pass?"). */
    dryRun?: boolean
    /** Minimum time between two trades of one agent, so nobody can spam tiny trades. */
    cooldownMs?: number
  } = {},
): Promise<TradeAuth> {
  const deny = (reason: TradeDenyReason): TradeAuth => ({ ok: false, reason })
  if (!Number.isSafeInteger(req.amount) || req.amount <= 0) return deny('invalid_amount')

  return db.transaction(async (tx) => {
    // Lock this agent's policy row: concurrent authorizations for one agent run one at a time.
    const [policy] = await queryRows<{
      paused: boolean
      per_trade_cap: string
      daily_cap: string
      token_allowlist: string
      status: string
      mode: string
    }>(
      tx as unknown as Db,
      sql`select p.paused, p.per_trade_cap, p.daily_cap, p.token_allowlist,
                 a.status, a.mode
          from policies p join agents a on a.id = p.agent_id
          where p.agent_id = ${req.agentId}
          for update of p`,
    )
    if (!policy) return deny('unknown_agent')
    if (policy.paused || policy.status !== 'active') return deny('paused')
    if (policy.mode !== 'trade' && policy.mode !== 'both') return deny('mode_not_trader')

    const allowlist = JSON.parse(policy.token_allowlist) as string[]
    const tradable = (TRADE_ASSETS as readonly string[]).includes(req.asset)
    if (!tradable || !allowlist.includes(req.asset)) return deny('asset_not_allowed')
    if (req.amount > Number(policy.per_trade_cap)) return deny('over_trade_cap')

    const [sums] = await queryRows<{
      day: string | null
      open: string | null
      last: string | null
    }>(
      tx as unknown as Db,
      sql`select
            sum(amount) filter (where created_at >= ${now - DAY_MS} and ${ACTIVE}) as day,
            sum(amount) filter (where status = 'reserved') as open,
            max(created_at) as last
          from spend_ledger where agent_id = ${req.agentId}`,
    )
    // One position at a time: a reservation in flight, or an intent not closed yet.
    const [live] = await tx
      .select({ n: count() })
      .from(schema.intents)
      .where(
        and(
          eq(schema.intents.agentId, req.agentId),
          inArray(schema.intents.state, ['DRAFT', 'COMMITTED', 'EXECUTING', 'EXECUTED']),
        ),
      )
    if (Number(sums?.open ?? 0) > 0 || (live?.n ?? 0) > 0) return deny('position_open')
    if (sums?.last != null && now - Number(sums.last) < (opts.cooldownMs ?? 0))
      return deny('cooldown')
    if (Number(sums?.day ?? 0) + req.amount > Number(policy.daily_cap))
      return deny('over_daily_cap')
    if (BigInt(req.amount) > usdcBalance) return deny('insufficient_funds')

    if (opts.dryRun) return { ok: true, reservationId: 'dry-run' }
    const reservationId = randomUUID()
    await tx.insert(schema.spendLedger).values({
      id: reservationId,
      agentId: req.agentId,
      roundId: req.roundId,
      kind: 'trade',
      amount: req.amount,
      status: 'reserved',
      ref: req.ref,
      createdAt: now,
      updatedAt: now,
    })
    return { ok: true, reservationId }
  })
}

/** Mark a reservation spent. `actualAmount` (≤ reserved) records what the fill really cost. */
export async function settleReservation(db: Db, reservationId: string, actualAmount?: number) {
  const [row] = await db
    .select()
    .from(schema.spendLedger)
    .where(eq(schema.spendLedger.id, reservationId))
  if (!row || row.status !== 'reserved') throw new Error(`reservation ${reservationId} is not open`)
  if (actualAmount !== undefined && (actualAmount < 0 || actualAmount > row.amount)) {
    throw new Error(`settled amount ${actualAmount} outside 0..${row.amount}`)
  }
  await db
    .update(schema.spendLedger)
    .set({ status: 'settled', amount: actualAmount ?? row.amount, updatedAt: Date.now() })
    .where(and(eq(schema.spendLedger.id, reservationId), eq(schema.spendLedger.status, 'reserved')))
}

/** Return a reservation's budget (the trade failed or was never sent). */
export async function releaseReservation(db: Db, reservationId: string) {
  const updated = await db
    .update(schema.spendLedger)
    .set({ status: 'released', updatedAt: Date.now() })
    .where(and(eq(schema.spendLedger.id, reservationId), eq(schema.spendLedger.status, 'reserved')))
    .returning({ id: schema.spendLedger.id })
  if (updated.length === 0) throw new Error(`reservation ${reservationId} is not open`)
}

/**
 * Predictions cost nothing, but are still gated: active predictor, market's window still open,
 * entry pending, not the same human as the trader (also enforced onchain), one per entry, and a
 * rolling 24h limit.
 */
export async function authorizePrediction(
  db: Db,
  req: { agentId: string; entryId: number },
  now = Date.now(),
): Promise<PredictionAuth> {
  const deny = (reason: PredictionDenyReason): PredictionAuth => ({ ok: false, reason })
  const [agent] = await queryRows<{
    status: string
    mode: string
    paused: boolean
    predictions_per_day: number
    human_id: string
  }>(
    db,
    sql`select a.status, a.mode, p.paused, p.predictions_per_day, o.human_id
        from agents a join policies p on p.agent_id = a.id join owners o on o.wallet = a.owner_wallet
        where a.id = ${req.agentId}`,
  )
  if (!agent) return deny('unknown_agent')
  if (agent.paused || agent.status !== 'active') return deny('paused')
  if (agent.mode !== 'predict' && agent.mode !== 'both') return deny('mode_not_predictor')

  const [entry] = await queryRows<{
    round_id: number
    outcome: string
    phase: string
    phase_ends_at: string
    trader_human_id: string
  }>(
    db,
    sql`select e.round_id, e.outcome, r.phase, r.phase_ends_at, o.human_id as trader_human_id
        from round_entries e
        join rounds r on r.id = e.round_id
        join agents t on t.id = e.trader_agent_id
        join owners o on o.wallet = t.owner_wallet
        where e.id = ${req.entryId}`,
  )
  if (!entry) return deny('unknown_entry')
  if (
    entry.phase !== 'PREDICTING' ||
    now >= Number(entry.phase_ends_at) ||
    entry.outcome !== 'PENDING'
  ) {
    return deny('predictions_closed')
  }
  if (entry.trader_human_id === agent.human_id) return deny('own_agent_entry')

  const [dup] = await db
    .select({ n: count() })
    .from(schema.predictions)
    .where(
      and(eq(schema.predictions.entryId, req.entryId), eq(schema.predictions.agentId, req.agentId)),
    )
  if ((dup?.n ?? 0) > 0) return deny('already_predicted')

  const [made] = await db
    .select({ n: count() })
    .from(schema.predictions)
    .where(
      and(
        eq(schema.predictions.agentId, req.agentId),
        gte(schema.predictions.createdAt, now - DAY_MS),
      ),
    )
  if ((made?.n ?? 0) >= agent.predictions_per_day) return deny('over_prediction_limit')
  return { ok: true }
}
