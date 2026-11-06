/**
 * Two independent loops. There is no shared round: every trade is its own market.
 *
 * Agents: each active agent thinks on its own schedule (brain/decide.ts) and chooses to buy,
 * predict or wait. A broadcast wakes predictors immediately.
 *
 * Markets: one per trade, driven by the `rounds` table so a restart resumes where it stopped:
 *
 *   OPENING → PREDICTING → TRADING → RESOLVING → SETTLED
 *
 * - OPENING: the trade is in flight. A market is only broadcast after a confirmed fill, so a
 *   failed order never reaches predictors.
 * - PREDICTING: open for `predictionWindowMs`, or until the position closes if that comes first.
 * - TRADING: predictions locked onchain, position still open.
 * - The position ends at its take-profit, its stop-loss, or is sold at `maxHoldMs`. Then the entry
 *   resolves from fills and predictions are scored.
 *
 * Reward epochs stay time-based: a market belongs to the epoch it opened in, and an epoch pays out
 * once all its markets have settled.
 */
import { and, desc, eq, inArray, lte, ne, sql } from 'drizzle-orm'
import { arenaAbi } from '@starter/shared/generated'
import { getAddress, type Address } from 'viem'
import { think } from '../brain/decide'
import type { AppContext } from '../context'
import { queryRows, schema } from '../db'
import { closePosition, syncExit } from '../execution/close'
import { recoverStuckIntents } from '../execution/trade'
import { settleEpoch, type EpochConfig } from '../rewards/epoch'
import { logActivity, setStatus, wakeAgent } from '../services/activity'
import { policySnapshot, resolveRound } from './resolver'

export type MarketConfig = {
  predictionWindowMs: number
  maxHoldMs: number
  /** How often an agent with nothing urgent thinks. */
  thinkEveryMs: number
  /** Below this ETH balance an agent can't send anything, so it doesn't try. */
  minGasWei: bigint
  /** How long a failing close is retried before the entry goes VOID so epochs can pay out. */
  closeGraceMs: number
  epochMs: number
  epoch: EpochConfig
}

type Market = typeof schema.rounds.$inferSelect

const log = (...args: unknown[]) => console.log('[markets]', ...args)

async function ensureEpoch(ctx: AppContext, cfg: MarketConfig) {
  const epochId = Math.floor(ctx.now() / cfg.epochMs)
  await ctx.db
    .insert(schema.rewardEpochs)
    .values({
      id: epochId,
      startsAt: epochId * cfg.epochMs,
      endsAt: (epochId + 1) * cfg.epochMs,
      budget: cfg.epoch.budget,
    })
    .onConflictDoNothing()
  return epochId
}

/** A market id for a trade about to happen: the intent commits to it before anything is sent. */
export async function reserveMarket(ctx: AppContext, cfg: MarketConfig): Promise<Market> {
  const [last] = await ctx.db.select().from(schema.rounds).orderBy(desc(schema.rounds.id)).limit(1)
  const now = ctx.now()
  const [market] = await ctx.db
    .insert(schema.rounds)
    .values({
      id: (last?.id ?? 0) + 1,
      phase: 'OPENING',
      epochId: await ensureEpoch(ctx, cfg),
      startsAt: now,
      phaseEndsAt: now,
    })
    .returning()
  return market!
}

async function setPhase(ctx: AppContext, id: number, fields: Partial<Market>) {
  await ctx.db.update(schema.rounds).set(fields).where(eq(schema.rounds.id, id))
  if (fields.phase) log(`market ${id} ${fields.phase}`)
}

/** The trade never happened, so there's nothing to predict on. */
export const settleEmptyMarket = (ctx: AppContext, id: number) =>
  setPhase(ctx, id, { phase: 'SETTLED' })

/** openEntry, unless a previous attempt got it onchain but stopped before saving it. */
async function openOnchain(ctx: AppContext, marketId: number, trader: Address) {
  const address = ctx.contracts.arena
  const existing = await ctx.publicClient.readContract({
    address,
    abi: arenaAbi,
    functionName: 'entryOf',
    args: [BigInt(marketId), trader],
  })
  if (existing === 0n) return ctx.arena.openEntry(marketId, trader)
  const latest = await ctx.publicClient.getBlockNumber()
  const [log] = await ctx.publicClient.getContractEvents({
    address,
    abi: arenaAbi,
    eventName: 'EntryOpened',
    args: { entryId: existing },
    fromBlock: latest > 2000n ? latest - 2000n : 0n,
  })
  return { hash: log?.transactionHash ?? null, entryId: Number(existing) }
}

/**
 * The broadcast: the filled trade becomes a public onchain market and every predictor that could
 * act on it is woken. Safe to retry: a failed openEntry leaves the market in OPENING.
 */
async function broadcastMarket(
  ctx: AppContext,
  cfg: MarketConfig,
  marketId: number,
  agent: typeof schema.agents.$inferSelect,
) {
  const [intent] = await ctx.db
    .select()
    .from(schema.intents)
    .where(eq(schema.intents.roundId, marketId))
  const [policy] = await ctx.db
    .select()
    .from(schema.policies)
    .where(eq(schema.policies.agentId, agent.id))
  if (!intent || !policy) throw new Error(`market ${marketId} has no trade`)
  const snap = policySnapshot(policy)
  const { hash, entryId } = await openOnchain(ctx, marketId, getAddress(agent.address))
  const [entry] = await ctx.db
    .insert(schema.roundEntries)
    .values({
      roundId: marketId,
      traderAgentId: agent.id,
      onchainEntryId: entryId,
      policySnapshot: snap.json,
      policySnapshotHash: snap.hash,
      tradeBudget: intent.sizeQuote,
      openTx: hash,
    })
    .returning()
  await ctx.db
    .update(schema.intents)
    .set({ entryId: entry!.id })
    .where(eq(schema.intents.intentId, intent.intentId))
  const now = ctx.now()
  await setPhase(ctx, marketId, {
    phase: 'PREDICTING',
    phaseEndsAt: now + cfg.predictionWindowMs,
    closesAt: now + cfg.maxHoldMs,
  })
  await logActivity(
    ctx,
    agent.id,
    'broadcast',
    `${agent.name} bought ${intent.sizeQuote / 1e6} USDC of ${intent.asset}. Will this trade make money?`,
    { entryId: entry!.id, decisionId: intent.decisionId ?? undefined },
  )
  const predictors = await ctx.db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(
      and(eq(schema.agents.status, 'active'), inArray(schema.agents.mode, ['predict', 'both'])),
    )
  for (const p of predictors) if (p.id !== agent.id) await wakeAgent(ctx, p.id)
}

async function stepOpening(ctx: AppContext, cfg: MarketConfig, market: Market) {
  const [intent] = await ctx.db
    .select()
    .from(schema.intents)
    .where(eq(schema.intents.roundId, market.id))
  if (intent?.state === 'FAILED') return settleEmptyMarket(ctx, market.id)
  if (!intent) {
    // Reserved, then the server stopped before the intent was written.
    if (ctx.now() - market.startsAt > cfg.closeGraceMs) await settleEmptyMarket(ctx, market.id)
    return
  }
  if (intent.state !== 'EXECUTED' && intent.state !== 'CLOSED') return
  const [agent] = await ctx.db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.id, intent.agentId))
  if (agent) await broadcastMarket(ctx, cfg, market.id, agent)
}

async function resolveMarket(ctx: AppContext, market: Market) {
  await setPhase(ctx, market.id, { phase: 'RESOLVING' })
  for (const r of await resolveRound(ctx, market.id)) {
    log(`market ${market.id} resolved: ${r.outcome} ${r.pnlBps} bps`)
    const [entry] = await ctx.db
      .select()
      .from(schema.roundEntries)
      .where(eq(schema.roundEntries.id, r.entryId))
    const text =
      r.outcome === 'VOID'
        ? `Trade voided: ${r.voidReason?.replaceAll('_', ' ')}`
        : `Trade closed ${r.outcome === 'YES' ? 'in profit' : 'at a loss'}: ${(r.pnlBps / 100).toFixed(2)}%`
    if (entry) {
      await logActivity(ctx, entry.traderAgentId, 'resolved', text, { entryId: entry.id })
      await wakeAgent(ctx, entry.traderAgentId)
    }
  }
  const [pending] = await ctx.db
    .select({ id: schema.roundEntries.id })
    .from(schema.roundEntries)
    .where(
      and(eq(schema.roundEntries.roundId, market.id), eq(schema.roundEntries.outcome, 'PENDING')),
    )
  // An onchain failure leaves it pending: stay in RESOLVING and retry on the next tick.
  if (!pending) await setPhase(ctx, market.id, { phase: 'SETTLED' })
}

async function stepOpen(ctx: AppContext, cfg: MarketConfig, market: Market) {
  const now = ctx.now()
  const closesAt = market.closesAt ?? now
  const openIntents = () =>
    ctx.db
      .select({ id: schema.intents.intentId })
      .from(schema.intents)
      .where(and(eq(schema.intents.roundId, market.id), eq(schema.intents.state, 'EXECUTED')))

  for (const { id } of await openIntents()) {
    // Flash being down or the agent being paused must never hold up the lock below.
    try {
      await syncExit(ctx, id)
      if (now >= closesAt) {
        const closed = await closePosition(ctx, id)
        log(`market ${market.id} time limit: ${closed.status}`)
      }
    } catch (err) {
      console.error(`[markets] market ${market.id} exit failed; will retry:`, err)
    }
  }
  const stillOpen = (await openIntents()).length > 0
  const giveUp = now >= closesAt + cfg.closeGraceMs

  // Predictions close the moment the outcome is known, never after it.
  if (
    market.phase === 'PREDICTING' &&
    (now >= market.phaseEndsAt || !stillOpen || now >= closesAt)
  ) {
    const lockTx = await ctx.arena.lockPredictions(market.id)
    await setPhase(ctx, market.id, { phase: 'TRADING', lockTx })
    if (!stillOpen || giveUp) await resolveMarket(ctx, { ...market, phase: 'TRADING', lockTx })
    return
  }
  if (market.phase === 'RESOLVING' || !stillOpen || giveUp) await resolveMarket(ctx, market)
}

/** A voided market can leave a position behind, e.g. the agent was paused. Finish it when we can. */
async function sweepOrphans(ctx: AppContext) {
  const rows = await queryRows<{ intent_id: string }>(
    ctx.db,
    sql`select i.intent_id from intents i
        join rounds r on r.id = i.round_id
        join agents a on a.id = i.agent_id
        where i.state = 'EXECUTED' and r.phase = 'SETTLED' and a.status = 'active'`,
  )
  for (const { intent_id } of rows) {
    await closePosition(ctx, intent_id).catch((err) =>
      console.error(`[markets] leftover ${intent_id} failed to close:`, err),
    )
  }
}

/** Advance every open market, then pay out finished epochs. Returns how many it looked at. */
export async function tickMarkets(ctx: AppContext, cfg: MarketConfig) {
  await ensureEpoch(ctx, cfg)
  await recoverStuckIntents(ctx)
  const open = await ctx.db
    .select()
    .from(schema.rounds)
    .where(ne(schema.rounds.phase, 'SETTLED'))
    .orderBy(schema.rounds.id)
  for (const market of open) {
    try {
      if (market.phase === 'OPENING') await stepOpening(ctx, cfg, market)
      else await stepOpen(ctx, cfg, market)
    } catch (err) {
      console.error(`[markets] market ${market.id} failed; will retry:`, err)
    }
  }
  await sweepOrphans(ctx)
  await settleDueEpochs(ctx, cfg)
  return open.length
}

export async function settleDueEpochs(ctx: AppContext, cfg: MarketConfig) {
  const due = await ctx.db
    .select()
    .from(schema.rewardEpochs)
    .where(and(eq(schema.rewardEpochs.status, 'open'), lte(schema.rewardEpochs.endsAt, ctx.now())))
  for (const epoch of due) {
    // Every market of the epoch must be settled first.
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
      console.error(`[markets] epoch ${epoch.id} settle failed; will retry:`, err)
    }
  }
}

/** Let every agent that's due think, one at a time. Returns how many thought. */
export async function tickAgents(ctx: AppContext, cfg: MarketConfig) {
  const agents = await ctx.db.select().from(schema.agents).where(eq(schema.agents.status, 'active'))
  const schedule = await ctx.db.select().from(schema.agentStatus)
  let thought = 0
  for (const agent of agents) {
    const due = schedule.find((s) => s.agentId === agent.id)?.nextThinkAt ?? 0
    if (ctx.now() < due) continue
    thought++
    try {
      const res = await think(ctx, agent, cfg)
      log(`${agent.name}: ${res.action}${'reason' in res ? ` (${res.reason})` : ''}`)
    } catch (err) {
      console.error(`[agents] ${agent.id} failed to think:`, err)
      const detail = err instanceof Error ? err.message : String(err)
      await setStatus(ctx, agent.id, 'error', detail, {
        nextThinkAt: ctx.now() + cfg.thinkEveryMs,
      })
    }
  }
  return thought
}

/** One pass of everything that's due (tests and local tooling). */
export async function tick(ctx: AppContext, cfg: MarketConfig) {
  const thought = await tickAgents(ctx, cfg)
  return { thought, markets: await tickMarkets(ctx, cfg) }
}

/** Run both loops on an interval. Slow thinking never delays a market. Returns a stop function. */
export function startScheduler(ctx: AppContext, cfg: MarketConfig, everyMs = 2000) {
  const loop = (name: string, step: () => Promise<unknown>) => {
    let running = false
    return setInterval(async () => {
      if (running) return
      running = true
      try {
        await step()
      } catch (err) {
        console.error(`[${name}] tick failed:`, err)
      } finally {
        running = false
      }
    }, everyMs)
  }
  const timers = [
    loop('markets', () => tickMarkets(ctx, cfg)),
    loop('agents', () => tickAgents(ctx, cfg)),
  ]
  return () => timers.forEach(clearInterval)
}
