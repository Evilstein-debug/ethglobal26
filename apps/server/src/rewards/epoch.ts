/**
 * Reward epochs. Scores come only from resolved, non-replay data in the epoch's rounds:
 *   - traders: net return = Σ realized PnL / Σ USDC spent over CLOSED intents (≥ minEntries
 *     resolved non-VOID entries); only positive returns earn.
 *   - predictors: mean Brier over scored predictions (≥ minPredictions); must beat 0.25 (a coin flip).
 * Awards go down each ranking, skipping humans already awarded this epoch (one per human, also
 * enforced onchain), sized by SHARES of a budget capped by the contract's epochCap and the
 * unallocated pool. Then Arena.publishEpoch; owners claim from their wallet.
 */
import { arenaAbi } from '@starter/shared/generated'
import { eq, sql } from 'drizzle-orm'
import type { Hex } from 'viem'
import type { AppContext } from '../context'
import { queryRows, schema } from '../db'

export type EpochConfig = { budget: number; minEntries: number; minPredictions: number }
export const TRADER_SHARES = [0.4, 0.25, 0.15]
export const PREDICTOR_SHARES = [0.2]

type Ranked = { agentId: string; humanId: string; ownerWallet: string; score: number }

export async function rankTraders(
  ctx: AppContext,
  epochId: number,
  minEntries: number,
): Promise<Ranked[]> {
  const rows = await queryRows<{
    agent_id: string
    human_id: string
    owner_wallet: string
    spent: string
    pnl: string
    entries: string
  }>(
    ctx.db,
    sql`select e.trader_agent_id as agent_id, o.human_id, o.wallet as owner_wallet,
               sum(i.usdc_spent) as spent, sum(i.usdc_received - i.usdc_spent) as pnl,
               count(distinct e.id) as entries
        from round_entries e
        join rounds r on r.id = e.round_id
        join intents i on i.entry_id = e.id and i.state = 'CLOSED'
        join agents a on a.id = e.trader_agent_id
        join owners o on o.wallet = a.owner_wallet
        where r.epoch_id = ${epochId} and e.outcome in ('YES', 'NO')
        group by e.trader_agent_id, o.human_id, o.wallet`,
  )
  return rows
    .filter((r) => Number(r.entries) >= minEntries && Number(r.spent) > 0)
    .map((r) => ({
      agentId: r.agent_id,
      humanId: r.human_id,
      ownerWallet: r.owner_wallet,
      score: Number(r.pnl) / Number(r.spent),
    }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
}

export async function rankPredictors(
  ctx: AppContext,
  epochId: number,
  minPredictions: number,
): Promise<Ranked[]> {
  const rows = await queryRows<{
    agent_id: string
    human_id: string
    owner_wallet: string
    mean: string
    n: string
  }>(
    ctx.db,
    sql`select p.agent_id, o.human_id, o.wallet as owner_wallet, avg(p.brier) as mean, count(*) as n
        from predictions p
        join rounds r on r.id = p.round_id
        join agents a on a.id = p.agent_id
        join owners o on o.wallet = a.owner_wallet
        where r.epoch_id = ${epochId} and p.brier is not null and p.agent_id is not null
        group by p.agent_id, o.human_id, o.wallet`,
  )
  return rows
    .filter((r) => Number(r.n) >= minPredictions && Number(r.mean) < 0.25)
    .map((r) => ({
      agentId: r.agent_id,
      humanId: r.human_id,
      ownerWallet: r.owner_wallet,
      score: Number(r.mean),
    }))
    .sort((a, b) => a.score - b.score)
}

/** Pure: pick winners down each ranking, one award per human, amounts from shares. */
export function allocateAwards(traders: Ranked[], predictors: Ranked[], budget: number) {
  const awarded = new Set<string>()
  const awards: (Ranked & { category: 'trader' | 'predictor'; rank: number; amount: number })[] = []
  const take = (list: Ranked[], shares: number[], category: 'trader' | 'predictor') => {
    let rank = 0
    for (const r of list) {
      if (rank >= shares.length) break
      if (awarded.has(r.humanId)) continue
      const amount = Math.floor(budget * shares[rank]!)
      rank++
      if (amount <= 0) continue
      awarded.add(r.humanId)
      awards.push({ ...r, category, rank, amount })
    }
  }
  take(traders, TRADER_SHARES, 'trader')
  take(predictors, PREDICTOR_SHARES, 'predictor')
  return awards
}

/** Compute and publish one epoch. Idempotent: a published epoch is returned as-is. */
export async function settleEpoch(ctx: AppContext, epochId: number, cfg: EpochConfig) {
  const [epoch] = await ctx.db
    .select()
    .from(schema.rewardEpochs)
    .where(eq(schema.rewardEpochs.id, epochId))
  if (!epoch) throw new Error(`unknown epoch ${epochId}`)
  if (epoch.status === 'published')
    return { epochId, status: 'published' as const, publishTx: epoch.publishTx }

  const [cap, available] = await Promise.all([
    ctx.publicClient.readContract({
      address: ctx.contracts.arena,
      abi: arenaAbi,
      functionName: 'epochCap',
    }),
    ctx.publicClient.readContract({
      address: ctx.contracts.arena,
      abi: arenaAbi,
      functionName: 'availablePool',
    }),
  ])
  const budget = Math.min(cfg.budget, Number(cap), Number(available))
  const awards = allocateAwards(
    await rankTraders(ctx, epochId, cfg.minEntries),
    await rankPredictors(ctx, epochId, cfg.minPredictions),
    budget,
  )
  if (awards.length === 0) {
    await ctx.db
      .update(schema.rewardEpochs)
      .set({ status: 'computed', budget })
      .where(eq(schema.rewardEpochs.id, epochId))
    return {
      epochId,
      status: 'computed' as const,
      awards: [],
      reason: budget === 0 ? 'pool_empty' : 'no_qualifying_agents',
    }
  }
  await ctx.db.transaction(async (tx) => {
    await tx.delete(schema.rewardAwards).where(eq(schema.rewardAwards.epochId, epochId))
    await tx.insert(schema.rewardAwards).values(
      awards.map((a) => ({
        epochId,
        humanId: a.humanId,
        ownerWallet: a.ownerWallet,
        agentId: a.agentId,
        category: a.category,
        rank: a.rank,
        amount: a.amount,
      })),
    )
  })
  const publishTx = await ctx.arena.publishEpoch(
    epochId,
    awards.map((a) => a.humanId as Hex),
    awards.map((a) => BigInt(a.amount)),
  )
  await ctx.db
    .update(schema.rewardEpochs)
    .set({ status: 'published', publishTx, budget })
    .where(eq(schema.rewardEpochs.id, epochId))
  return { epochId, status: 'published' as const, publishTx, awards }
}
