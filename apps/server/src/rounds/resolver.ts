/**
 * Resolve a round's entries from their committed intents (never from agent self-reports):
 *   realized PnL = Σ(usdc_received − usdc_spent) over CLOSED intents of the entry
 *   PnL > 0 → YES; PnL ≤ 0 → NO;
 *   VOID if: no executed trade, the policy changed since the snapshot, or any intent is unsettled
 *   (still open/executing, or a close failed) — a resolution we can't stand behind.
 * Then Arena.resolveEntry, Brier scores for every prediction, and agent_stats.
 */
import { canonicalHash } from '@starter/shared/canonical'
import { and, eq, sql } from 'drizzle-orm'
import type { AppContext } from '../context'
import { schema } from '../db'

export type EntryResolution = {
  entryId: number
  outcome: 'YES' | 'NO' | 'VOID'
  pnlBps: number
  voidReason?: string
  resolveTx?: string
}

export function policySnapshot(policy: typeof schema.policies.$inferSelect) {
  const snap = {
    perTradeCap: policy.perTradeCap,
    dailyCap: policy.dailyCap,
    tokenAllowlist: JSON.parse(policy.tokenAllowlist) as string[],
    paused: policy.paused,
  }
  return { json: JSON.stringify(snap), hash: canonicalHash(snap) }
}

/** Brier score of one prediction (lower is better). */
export function brier(probYesBps: number, outcome: 'YES' | 'NO') {
  const p = probYesBps / 10_000
  const y = outcome === 'YES' ? 1 : 0
  return (p - y) ** 2
}

export async function computeEntryOutcome(
  ctx: AppContext,
  entry: typeof schema.roundEntries.$inferSelect,
) {
  const intents = await ctx.db
    .select()
    .from(schema.intents)
    .where(eq(schema.intents.entryId, entry.id))
  const [policy] = await ctx.db
    .select()
    .from(schema.policies)
    .where(eq(schema.policies.agentId, entry.traderAgentId))
  if (!policy || policySnapshot(policy).hash !== entry.policySnapshotHash) {
    return { outcome: 'VOID' as const, pnlBps: 0, voidReason: 'policy_changed' }
  }
  const unsettled = intents.filter((i) =>
    ['DRAFT', 'COMMITTED', 'EXECUTING', 'EXECUTED'].includes(i.state),
  )
  if (unsettled.length)
    return { outcome: 'VOID' as const, pnlBps: 0, voidReason: 'unsettled_intent' }
  const closed = intents.filter(
    (i) => i.state === 'CLOSED' && i.usdcSpent != null && i.usdcReceived != null,
  )
  if (!closed.length) return { outcome: 'VOID' as const, pnlBps: 0, voidReason: 'no_trades' }
  const spent = closed.reduce((s, i) => s + i.usdcSpent!, 0)
  const pnl = closed.reduce((s, i) => s + (i.usdcReceived! - i.usdcSpent!), 0)
  const pnlBps = spent > 0 ? Math.round((pnl * 10_000) / spent) : 0
  return { outcome: pnl > 0 ? ('YES' as const) : ('NO' as const), pnlBps }
}

async function bumpStats(
  ctx: AppContext,
  agentId: string,
  role: 'trader' | 'predictor',
  delta: {
    rounds?: number
    wins?: number
    losses?: number
    voids?: number
    pnlBps?: number
    brier?: number
  },
) {
  await ctx.db
    .insert(schema.agentStats)
    .values({
      agentId,
      role,
      replay: false,
      rounds: delta.rounds ?? 0,
      wins: delta.wins ?? 0,
      losses: delta.losses ?? 0,
      voids: delta.voids ?? 0,
      pnlBpsTotal: delta.pnlBps ?? 0,
      brierSum: delta.brier ?? 0,
      brierCount: delta.brier === undefined ? 0 : 1,
    })
    .onConflictDoUpdate({
      target: [schema.agentStats.agentId, schema.agentStats.role, schema.agentStats.replay],
      set: {
        rounds: sql`${schema.agentStats.rounds} + ${delta.rounds ?? 0}`,
        wins: sql`${schema.agentStats.wins} + ${delta.wins ?? 0}`,
        losses: sql`${schema.agentStats.losses} + ${delta.losses ?? 0}`,
        voids: sql`${schema.agentStats.voids} + ${delta.voids ?? 0}`,
        pnlBpsTotal: sql`${schema.agentStats.pnlBpsTotal} + ${delta.pnlBps ?? 0}`,
        brierSum: sql`${schema.agentStats.brierSum} + ${delta.brier ?? 0}`,
        brierCount: sql`${schema.agentStats.brierCount} + ${delta.brier === undefined ? 0 : 1}`,
        updatedAt: ctx.now(),
      },
    })
}

/** Resolve every pending entry of a round. Safe to re-run: resolved entries are skipped. */
export async function resolveRound(ctx: AppContext, roundId: number): Promise<EntryResolution[]> {
  const entries = await ctx.db
    .select()
    .from(schema.roundEntries)
    .where(
      and(eq(schema.roundEntries.roundId, roundId), eq(schema.roundEntries.outcome, 'PENDING')),
    )
  const results: EntryResolution[] = []
  for (const entry of entries) {
    const r = await computeEntryOutcome(ctx, entry)
    let resolveTx: string | undefined
    if (entry.onchainEntryId != null) {
      try {
        resolveTx = await ctx.arena.resolveEntry(entry.onchainEntryId, r.outcome, r.pnlBps)
      } catch (err) {
        console.error(`[resolver] entry ${entry.id} onchain resolve failed; will retry:`, err)
        continue
      }
    }
    await ctx.db
      .update(schema.roundEntries)
      .set({
        outcome: r.outcome,
        pnlBps: r.pnlBps,
        voidReason: r.voidReason ?? null,
        resolveTx: resolveTx ?? null,
      })
      .where(eq(schema.roundEntries.id, entry.id))

    await bumpStats(ctx, entry.traderAgentId, 'trader', {
      rounds: 1,
      wins: r.outcome === 'YES' ? 1 : 0,
      losses: r.outcome === 'NO' ? 1 : 0,
      voids: r.outcome === 'VOID' ? 1 : 0,
      pnlBps: r.outcome === 'VOID' ? 0 : r.pnlBps,
    })
    const preds = await ctx.db
      .select()
      .from(schema.predictions)
      .where(eq(schema.predictions.entryId, entry.id))
    for (const p of preds) {
      if (r.outcome === 'VOID') {
        if (p.agentId) await bumpStats(ctx, p.agentId, 'predictor', { rounds: 1, voids: 1 })
        continue
      }
      const score = brier(p.probYesBps, r.outcome)
      await ctx.db
        .update(schema.predictions)
        .set({ brier: score })
        .where(eq(schema.predictions.predictionId, p.predictionId))
      if (p.agentId) {
        const right = p.side === r.outcome
        await bumpStats(ctx, p.agentId, 'predictor', {
          rounds: 1,
          wins: right ? 1 : 0,
          losses: right ? 0 : 1,
          brier: score,
        })
      }
    }
    results.push({ entryId: entry.id, ...r, resolveTx })
  }
  return results
}
