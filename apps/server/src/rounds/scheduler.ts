/**
 * Round state machine, driven by the `rounds` table so a restart resumes where it stopped:
 *
 *   REGISTRATION → PREDICTING → TRADING → RESOLVING → SETTLED
 *
 * - enter REGISTRATION: allocation decision per trade/both agent; opting-in traders get an
 *   onchain entry (Arena.openEntry) with a policy snapshot and budget.
 * - enter PREDICTING: prediction decisions per predict/both agent.
 * - enter TRADING: Arena.lockPredictions (late predictions revert onchain), then a trade decision
 *   per entry; entries that held get one more decision at mid-phase.
 * - end of TRADING: close every open position, resolve every entry, settle finished epochs.
 *
 * `tick()` performs whatever transition is due at ctx.now(); the timer just calls it.
 */
import { and, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm'
import { getAddress } from 'viem'
import type { AppContext } from '../context'
import { queryRows, schema } from '../db'
import { decideAllocation, decidePredictions, decideTrade } from '../brain/decide'
import { closePosition } from '../execution/close'
import { settleEpoch, type EpochConfig } from '../rewards/epoch'
import { policySnapshot, resolveRound } from './resolver'

export type RoundConfig = {
  registrationMs: number
  predictingMs: number
  tradingMs: number
  /** Pause between a settled round and the next one. */
  gapMs: number
  epochMs: number
  epoch: EpochConfig
  /** Max trade decisions per entry per round. */
  maxTradeDecisions: number
}

type Round = typeof schema.rounds.$inferSelect

const log = (...args: unknown[]) => console.log('[rounds]', ...args)

async function activeAgents(ctx: AppContext, modes: ('trade' | 'predict' | 'both')[]) {
  return ctx.db
    .select()
    .from(schema.agents)
    .where(and(eq(schema.agents.status, 'active'), inArray(schema.agents.mode, modes)))
}

async function ensureEpoch(ctx: AppContext, epochId: number, cfg: RoundConfig) {
  await ctx.db
    .insert(schema.rewardEpochs)
    .values({
      id: epochId,
      startsAt: epochId * cfg.epochMs,
      endsAt: (epochId + 1) * cfg.epochMs,
      budget: cfg.epoch.budget,
    })
    .onConflictDoNothing()
}

export async function startRound(ctx: AppContext, cfg: RoundConfig): Promise<Round> {
  const now = ctx.now()
  const [last] = await ctx.db.select().from(schema.rounds).orderBy(desc(schema.rounds.id)).limit(1)
  const id = (last?.id ?? 0) + 1
  const epochId = Math.floor(now / cfg.epochMs)
  await ensureEpoch(ctx, epochId, cfg)
  const [round] = await ctx.db
    .insert(schema.rounds)
    .values({
      id,
      phase: 'REGISTRATION',
      epochId,
      startsAt: now,
      phaseEndsAt: now + cfg.registrationMs,
    })
    .returning()
  log(`round ${id} REGISTRATION`)

  for (const agent of await activeAgents(ctx, ['trade', 'both'])) {
    const alloc = await decideAllocation(ctx, agent, id)
    if (!alloc.trade || !('budget' in alloc) || !alloc.budget) continue
    const [policy] = await ctx.db
      .select()
      .from(schema.policies)
      .where(eq(schema.policies.agentId, agent.id))
    if (!policy || policy.paused) continue
    const snap = policySnapshot(policy)
    try {
      const { hash, entryId } = await ctx.arena.openEntry(id, getAddress(agent.address))
      await ctx.db.insert(schema.roundEntries).values({
        roundId: id,
        traderAgentId: agent.id,
        onchainEntryId: entryId,
        policySnapshot: snap.json,
        policySnapshotHash: snap.hash,
        tradeBudget: alloc.budget,
        allocationDecisionId: alloc.decisionId,
        openTx: hash,
      })
    } catch (err) {
      console.error(`[rounds] openEntry failed for ${agent.id}:`, err)
    }
  }
  return round!
}

async function setPhase(
  ctx: AppContext,
  round: Round,
  phase: Round['phase'],
  durationMs: number,
  extra: Partial<Round> = {},
) {
  await ctx.db
    .update(schema.rounds)
    .set({ phase, phaseEndsAt: ctx.now() + durationMs, ...extra })
    .where(eq(schema.rounds.id, round.id))
  log(`round ${round.id} ${phase}`)
}

async function enterPredicting(ctx: AppContext, round: Round, cfg: RoundConfig) {
  await setPhase(ctx, round, 'PREDICTING', cfg.predictingMs)
  for (const agent of await activeAgents(ctx, ['predict', 'both'])) {
    await decidePredictions(ctx, agent, round.id)
  }
}

async function tradeDecisionsFor(
  ctx: AppContext,
  round: Round,
  cfg: RoundConfig,
  onlyIdle: boolean,
) {
  const entries = await ctx.db
    .select()
    .from(schema.roundEntries)
    .where(eq(schema.roundEntries.roundId, round.id))
  for (const entry of entries) {
    const [counts] = await queryRows<{ decisions: string; live: string }>(
      ctx.db,
      sql`select
            (select count(*) from decisions where agent_id = ${entry.traderAgentId} and round_id = ${round.id} and kind = 'trade') as decisions,
            (select count(*) from intents where entry_id = ${entry.id} and state in ('EXECUTED','CLOSED','EXECUTING','COMMITTED')) as live`,
    )
    if (Number(counts?.decisions ?? 0) >= cfg.maxTradeDecisions) continue
    if (onlyIdle && Number(counts?.live ?? 0) > 0) continue
    const [agent] = await ctx.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, entry.traderAgentId))
    if (!agent || agent.status !== 'active') continue
    const res = await decideTrade(ctx, agent, {
      roundId: round.id,
      entryId: entry.id,
      budget: entry.tradeBudget,
      roundEndsAt: round.startsAt + cfg.registrationMs + cfg.predictingMs + cfg.tradingMs,
    })
    log(
      `round ${round.id} entry ${entry.id}: ${res.action}${'reason' in res ? ` (${res.reason})` : ''}`,
    )
  }
}

async function enterTrading(ctx: AppContext, round: Round, cfg: RoundConfig) {
  const lockTx = await ctx.arena.lockPredictions(round.id)
  await setPhase(ctx, round, 'TRADING', cfg.tradingMs, { lockTx })
  await tradeDecisionsFor(ctx, round, cfg, false)
}

async function finishRound(ctx: AppContext, round: Round, cfg: RoundConfig) {
  await setPhase(ctx, round, 'RESOLVING', 0)
  const open = await ctx.db
    .select({ intentId: schema.intents.intentId })
    .from(schema.intents)
    .where(and(eq(schema.intents.roundId, round.id), eq(schema.intents.state, 'EXECUTED')))
  for (const { intentId } of open) {
    const closed = await closePosition(ctx, intentId)
    log(`round ${round.id} close ${intentId}: ${closed.status}`)
  }
  const results = await resolveRound(ctx, round.id)
  log(
    `round ${round.id} resolved: ${results.map((r) => `${r.entryId}=${r.outcome}`).join(' ') || 'no entries'}`,
  )
  await setPhase(ctx, round, 'SETTLED', 0)
  await settleDueEpochs(ctx, cfg)
}

export async function settleDueEpochs(ctx: AppContext, cfg: RoundConfig) {
  const due = await ctx.db
    .select()
    .from(schema.rewardEpochs)
    .where(and(eq(schema.rewardEpochs.status, 'open'), lte(schema.rewardEpochs.endsAt, ctx.now())))
  for (const epoch of due) {
    // Every round of the epoch must be settled first.
    const [pending] = await ctx.db
      .select({ id: schema.rounds.id })
      .from(schema.rounds)
      .where(and(eq(schema.rounds.epochId, epoch.id), ne(schema.rounds.phase, 'SETTLED')))
      .limit(1)
    if (pending) continue
    try {
      const res = await settleEpoch(ctx, epoch.id, cfg.epoch)
      log(`epoch ${epoch.id}: ${res.status}`)
    } catch (err) {
      console.error(`[rounds] epoch ${epoch.id} settle failed; will retry:`, err)
    }
  }
}

/** Do whatever is due now. Returns the phase it acted on (for logs and tests). */
export async function tick(ctx: AppContext, cfg: RoundConfig): Promise<string> {
  const now = ctx.now()
  const [round] = await ctx.db.select().from(schema.rounds).orderBy(desc(schema.rounds.id)).limit(1)
  if (!round || round.phase === 'SETTLED') {
    // Finished epochs pay out before the next round can start a new one.
    if (round) await settleDueEpochs(ctx, cfg)
    if (!round || now >= round.phaseEndsAt + cfg.gapMs) {
      await startRound(ctx, cfg)
      return 'started'
    }
    return 'idle'
  }
  if (
    round.phase === 'TRADING' &&
    now < round.phaseEndsAt &&
    now >= round.phaseEndsAt - cfg.tradingMs / 2
  ) {
    await tradeDecisionsFor(ctx, round, cfg, true) // second chance for entries that held
  }
  if (now < round.phaseEndsAt) return 'waiting'
  if (round.phase === 'REGISTRATION') await enterPredicting(ctx, round, cfg)
  else if (round.phase === 'PREDICTING') await enterTrading(ctx, round, cfg)
  else await finishRound(ctx, round, cfg) // TRADING or a crashed RESOLVING
  return round.phase
}

/** Run tick() on an interval, never overlapping. Returns a stop function. */
export function startScheduler(ctx: AppContext, cfg: RoundConfig, everyMs = 2000) {
  let running = false
  let stopped = false
  const timer = setInterval(async () => {
    if (running || stopped) return
    running = true
    try {
      await tick(ctx, cfg)
    } catch (err) {
      console.error('[rounds] tick failed:', err)
    } finally {
      running = false
    }
  }, everyMs)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
