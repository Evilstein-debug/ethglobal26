/** Public read API: rounds, entries, leaderboards, epochs, agent activity. No auth, no secrets. */
import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import { Router, type Request } from 'express'
import { getAddress } from 'viem'
import type { AppContext } from '../context'
import { queryRows, schema } from '../db'
import { handler, HttpError } from '../http'

const usdc = (units: number | null | undefined) => (units == null ? null : units / 1e6)

export function arenaRouter(ctx: AppContext) {
  const r = Router()

  async function entriesOf(roundId: number) {
    const rows = await queryRows<{
      id: number
      onchain_entry_id: number | null
      trader_agent_id: string
      trader_name: string
      trader_address: string
      outcome: string
      pnl_bps: number | null
      void_reason: string | null
      trade_budget: string
      open_tx: string | null
      resolve_tx: string | null
      yes: string
      no: string
      avg_prob: string | null
    }>(
      ctx.db,
      sql`select e.id, e.onchain_entry_id, e.trader_agent_id, a.name as trader_name, a.address as trader_address,
                 e.outcome, e.pnl_bps, e.void_reason, e.trade_budget, e.open_tx, e.resolve_tx,
                 count(p.prediction_id) filter (where p.side = 'YES') as yes,
                 count(p.prediction_id) filter (where p.side = 'NO') as no,
                 avg(p.prob_yes_bps) as avg_prob
          from round_entries e
          join agents a on a.id = e.trader_agent_id
          left join predictions p on p.entry_id = e.id
          where e.round_id = ${roundId}
          group by e.id, a.name, a.address
          order by e.id`,
    )
    return rows.map((e) => ({
      id: e.id,
      onchainEntryId: e.onchain_entry_id,
      trader: { id: e.trader_agent_id, name: e.trader_name, address: getAddress(e.trader_address) },
      outcome: e.outcome,
      pnlBps: e.pnl_bps,
      voidReason: e.void_reason,
      tradeBudgetUsdc: usdc(Number(e.trade_budget)),
      openTx: e.open_tx,
      resolveTx: e.resolve_tx,
      predictions: {
        yes: Number(e.yes),
        no: Number(e.no),
        avgProbYesBps: e.avg_prob == null ? null : Math.round(Number(e.avg_prob)),
      },
    }))
  }

  async function roundView(round: typeof schema.rounds.$inferSelect) {
    return { ...round, serverTime: ctx.now(), entries: await entriesOf(round.id) }
  }

  r.get(
    '/rounds/current',
    handler(async (_req, res) => {
      const [round] = await ctx.db
        .select()
        .from(schema.rounds)
        .orderBy(desc(schema.rounds.id))
        .limit(1)
      res.json(round ? await roundView(round) : { round: null, serverTime: ctx.now() })
    }),
  )

  r.get(
    '/rounds',
    handler(async (_req, res) => {
      const rounds = await ctx.db
        .select()
        .from(schema.rounds)
        .orderBy(desc(schema.rounds.id))
        .limit(50)
      res.json({ rounds })
    }),
  )

  r.get(
    '/rounds/:id',
    handler(async (req: Request, res) => {
      const [round] = await ctx.db
        .select()
        .from(schema.rounds)
        .where(eq(schema.rounds.id, Number(req.params.id)))
      if (!round) throw new HttpError(404, 'round_not_found')
      res.json(await roundView(round))
    }),
  )

  /** Everything needed to verify one entry: commits, fills, predictions, 0G decisions. */
  r.get(
    '/entries/:id',
    handler(async (req: Request, res) => {
      const [entry] = await ctx.db
        .select()
        .from(schema.roundEntries)
        .where(eq(schema.roundEntries.id, Number(req.params.id)))
      if (!entry) throw new HttpError(404, 'entry_not_found')
      const [trader] = await ctx.db
        .select()
        .from(schema.agents)
        .where(eq(schema.agents.id, entry.traderAgentId))
      const [round] = await ctx.db
        .select()
        .from(schema.rounds)
        .where(eq(schema.rounds.id, entry.roundId))
      const intents = await ctx.db
        .select()
        .from(schema.intents)
        .where(eq(schema.intents.entryId, entry.id))
      const predictions = await ctx.db
        .select()
        .from(schema.predictions)
        .where(eq(schema.predictions.entryId, entry.id))
      const decisionIds = [
        ...intents.map((i) => i.decisionId),
        ...predictions.map((p) => p.decisionId),
        entry.allocationDecisionId,
      ].filter((x): x is string => Boolean(x))
      const decisions = decisionIds.length
        ? await ctx.db
            .select({
              id: schema.decisions.id,
              kind: schema.decisions.kind,
              model: schema.decisions.model,
              requestId: schema.decisions.requestId,
              provider: schema.decisions.provider,
              chatId: schema.decisions.chatId,
              teeVerified: schema.decisions.teeVerified,
              accepted: schema.decisions.accepted,
              rejectReason: schema.decisions.rejectReason,
              createdAt: schema.decisions.createdAt,
            })
            .from(schema.decisions)
            .where(inArray(schema.decisions.id, decisionIds))
        : []
      res.json({
        chainId: ctx.chain.id,
        entry,
        round: round && { id: round.id, phase: round.phase, lockTx: round.lockTx },
        trader: trader && {
          id: trader.id,
          name: trader.name,
          address: getAddress(trader.address),
          owner: getAddress(trader.ownerWallet),
        },
        intents,
        predictions,
        decisions,
        contracts: ctx.contracts,
      })
    }),
  )

  r.get(
    '/leaderboard',
    handler(async (_req, res) => {
      const traders = await queryRows<{
        agent_id: string
        name: string
        address: string
        owner: string
        replay: boolean
        rounds: number
        wins: number
        losses: number
        voids: number
        pnl_bps_total: number
        spent: string | null
        pnl: string | null
      }>(
        ctx.db,
        sql`select s.agent_id, a.name, a.address, a.owner_wallet as owner, s.replay, s.rounds, s.wins, s.losses, s.voids, s.pnl_bps_total,
                   (select sum(usdc_spent) from intents i where i.agent_id = s.agent_id and i.state = 'CLOSED') as spent,
                   (select sum(usdc_received - usdc_spent) from intents i where i.agent_id = s.agent_id and i.state = 'CLOSED') as pnl
            from agent_stats s join agents a on a.id = s.agent_id
            where s.role = 'trader'`,
      )
      const predictors = await queryRows<{
        agent_id: string
        name: string
        address: string
        owner: string
        replay: boolean
        rounds: number
        wins: number
        losses: number
        voids: number
        brier_sum: number
        brier_count: number
      }>(
        ctx.db,
        sql`select s.agent_id, a.name, a.address, a.owner_wallet as owner, s.replay, s.rounds, s.wins, s.losses, s.voids, s.brier_sum, s.brier_count
            from agent_stats s join agents a on a.id = s.agent_id
            where s.role = 'predictor'`,
      )
      res.json({
        traders: traders
          .map((t) => ({
            agentId: t.agent_id,
            name: t.name,
            address: getAddress(t.address),
            owner: getAddress(t.owner),
            replay: t.replay,
            rounds: t.rounds,
            wins: t.wins,
            losses: t.losses,
            voids: t.voids,
            // Replay rows have no fills: mean return per scored round, from the labeled seed.
            netReturnPct: t.replay
              ? t.pnl_bps_total / Math.max(1, t.wins + t.losses) / 100
              : t.spent && Number(t.spent) > 0
                ? (Number(t.pnl) / Number(t.spent)) * 100
                : null,
            realizedPnlUsdc: t.pnl == null ? 0 : Number(t.pnl) / 1e6,
          }))
          .sort((a, b) => (b.netReturnPct ?? -Infinity) - (a.netReturnPct ?? -Infinity)),
        predictors: predictors
          .map((p) => ({
            agentId: p.agent_id,
            name: p.name,
            address: getAddress(p.address),
            owner: getAddress(p.owner),
            replay: p.replay,
            predictions: p.rounds,
            correct: p.wins,
            wrong: p.losses,
            voided: p.voids,
            meanBrier: p.brier_count ? p.brier_sum / p.brier_count : null,
          }))
          .sort((a, b) => (a.meanBrier ?? Infinity) - (b.meanBrier ?? Infinity)),
        note: 'Rows with replay=true come from labeled replay data, not live rounds.',
      })
    }),
  )

  r.get(
    '/epochs',
    handler(async (_req, res) => {
      const epochs = await ctx.db
        .select()
        .from(schema.rewardEpochs)
        .orderBy(desc(schema.rewardEpochs.id))
        .limit(24)
      const awards = epochs.length
        ? await ctx.db
            .select()
            .from(schema.rewardAwards)
            .where(
              inArray(
                schema.rewardAwards.epochId,
                epochs.map((e) => e.id),
              ),
            )
        : []
      res.json({
        epochs: epochs.map((e) => ({
          ...e,
          budgetUsdc: usdc(e.budget),
          awards: awards
            .filter((a) => a.epochId === e.id)
            .map((a) => ({ ...a, amountUsdc: usdc(a.amount) })),
        })),
      })
    }),
  )

  r.get(
    '/owners/:wallet/awards',
    handler(async (req: Request, res) => {
      const awards = await ctx.db
        .select()
        .from(schema.rewardAwards)
        .where(eq(schema.rewardAwards.ownerWallet, String(req.params.wallet).toLowerCase()))
        .orderBy(desc(schema.rewardAwards.epochId))
      res.json({ awards: awards.map((a) => ({ ...a, amountUsdc: usdc(a.amount) })) })
    }),
  )

  /** Public decision log for an agent: every 0G call with its request ID, plus predictions. */
  r.get(
    '/agents/:id/activity',
    handler(async (req: Request, res) => {
      const agentId = String(req.params.id)
      const [decisions, predictions, stats] = await Promise.all([
        ctx.db
          .select({
            id: schema.decisions.id,
            roundId: schema.decisions.roundId,
            kind: schema.decisions.kind,
            model: schema.decisions.model,
            requestId: schema.decisions.requestId,
            teeVerified: schema.decisions.teeVerified,
            accepted: schema.decisions.accepted,
            rejectReason: schema.decisions.rejectReason,
            rawOutput: schema.decisions.rawOutput,
            createdAt: schema.decisions.createdAt,
          })
          .from(schema.decisions)
          .where(eq(schema.decisions.agentId, agentId))
          .orderBy(desc(schema.decisions.createdAt))
          .limit(50),
        ctx.db
          .select()
          .from(schema.predictions)
          .where(eq(schema.predictions.agentId, agentId))
          .orderBy(desc(schema.predictions.createdAt))
          .limit(50),
        ctx.db
          .select()
          .from(schema.agentStats)
          .where(and(eq(schema.agentStats.agentId, agentId))),
      ])
      res.json({ decisions, predictions, stats })
    }),
  )
  return r
}
