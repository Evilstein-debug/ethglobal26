/** Public read API: markets, entries, leaderboards, epochs, agent activity. No auth, no secrets. */
import { and, desc, eq, inArray, ne, sql } from 'drizzle-orm'
import type { TradeIntent } from '@starter/shared/schemas'
import { Router, type Request } from 'express'
import { getAddress } from 'viem'
import type { AppContext } from '../context'
import { queryRows, schema } from '../db'
import { flashReceipt } from '../execution/receipt'
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
      trader_owner: string
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
      sql`select e.id, e.onchain_entry_id, e.trader_agent_id, a.name as trader_name, a.address as trader_address, a.owner_wallet as trader_owner,
                 e.outcome, e.pnl_bps, e.void_reason, e.trade_budget, e.open_tx, e.resolve_tx,
                 count(p.prediction_id) filter (where p.side = 'YES') as yes,
                 count(p.prediction_id) filter (where p.side = 'NO') as no,
                 avg(p.prob_yes_bps) as avg_prob
          from round_entries e
          join agents a on a.id = e.trader_agent_id
          left join predictions p on p.entry_id = e.id
          where e.round_id = ${roundId}
          group by e.id, a.name, a.address, a.owner_wallet
          order by e.id`,
    )
    return rows.map((e) => ({
      id: e.id,
      onchainEntryId: e.onchain_entry_id,
      trader: {
        id: e.trader_agent_id,
        name: e.trader_name,
        address: getAddress(e.trader_address),
        owner: getAddress(e.trader_owner),
      },
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

  /** What the market is about: the trade itself, once it has filled. */
  async function marketView(market: typeof schema.rounds.$inferSelect) {
    const [trade] = await ctx.db
      .select()
      .from(schema.intents)
      .where(eq(schema.intents.roundId, market.id))
    return {
      id: market.id,
      phase: market.phase,
      epochId: market.epochId,
      openedAt: market.startsAt,
      predictionsCloseAt: market.phaseEndsAt,
      closesAt: market.closesAt,
      lockTx: market.lockTx,
      trade: trade && {
        asset: trade.asset,
        sizeUsdc: usdc(trade.sizeQuote),
        entryPrice: trade.entryRefPrice,
        targetPrice: trade.targetPrice,
        stopPrice: trade.stopPrice,
        state: trade.state,
        rationale: (JSON.parse(trade.canonicalJson) as TradeIntent).rationale,
      },
      entries: await entriesOf(market.id),
    }
  }

  /** Markets people can act on, then the most recent finished ones. */
  r.get(
    '/markets',
    handler(async (_req, res) => {
      const rows = await ctx.db
        .select()
        .from(schema.rounds)
        .where(ne(schema.rounds.phase, 'SETTLED'))
        .orderBy(desc(schema.rounds.id))
      const recent = await ctx.db
        .select()
        .from(schema.rounds)
        .where(eq(schema.rounds.phase, 'SETTLED'))
        .orderBy(desc(schema.rounds.id))
        .limit(40)
      const views = async (list: typeof rows) =>
        (await Promise.all(list.map(marketView))).filter((m) => m.entries.length)
      res.json({
        serverTime: ctx.now(),
        open: await views(rows),
        recent: (await views(recent)).slice(0, 20),
      })
    }),
  )

  /** Each agent right now, plus what they've been doing. `?owner=` narrows it to one owner. */
  r.get(
    '/activity',
    handler(async (req: Request, res) => {
      const owner = typeof req.query.owner === 'string' ? req.query.owner.toLowerCase() : null
      const mine = owner ? sql`a.owner_wallet = ${owner}` : sql`true`
      const agents = await queryRows<{
        id: string
        name: string
        mode: string
        address: string
        owner_wallet: string
        status: string
        state: string | null
        detail: string | null
        next_think_at: string | null
        updated_at: string | null
      }>(
        ctx.db,
        sql`select a.id, a.name, a.mode, a.address, a.owner_wallet, a.status,
                   s.state, s.detail, s.next_think_at, s.updated_at
            from agents a
            left join agent_status s on s.agent_id = a.id
            where ${mine}
            order by a.created_at`,
      )
      const events = await queryRows<{
        id: number
        agent_id: string
        agent_name: string
        state: string
        message: string
        rationale: string | null
        detail: string | null
        entry_id: number | null
        created_at: string
        request_id: string | null
        tee_verified: boolean | null
        accepted: boolean | null
        reject_reason: string | null
        model: string | null
        latency_ms: string | null
      }>(
        ctx.db,
        sql`select v.id, v.agent_id, a.name as agent_name, v.state, v.message, v.rationale,
                   v.detail, v.entry_id, v.created_at,
                   d.request_id, d.tee_verified, d.accepted, d.reject_reason, d.model, d.latency_ms
            from agent_activity v
            join agents a on a.id = v.agent_id
            left join decisions d on d.id = v.decision_id
            where ${mine}
            order by v.id desc
            limit 200`,
      )
      res.json({
        serverTime: ctx.now(),
        agents: agents.map((a) => ({
          id: a.id,
          name: a.name,
          mode: a.mode,
          address: getAddress(a.address),
          owner: getAddress(a.owner_wallet),
          state: a.status === 'paused' ? 'paused' : (a.state ?? 'idle'),
          detail: a.status === 'paused' ? 'Paused by its owner' : (a.detail ?? 'Starting up'),
          nextThinkAt: a.status === 'paused' || !a.next_think_at ? null : Number(a.next_think_at),
          updatedAt: a.updated_at == null ? null : Number(a.updated_at),
        })),
        events: events.map((e) => ({
          id: e.id,
          agentId: e.agent_id,
          agentName: e.agent_name,
          state: e.state,
          message: e.message,
          rationale: e.rationale,
          detail: e.detail,
          entryId: e.entry_id,
          at: Number(e.created_at),
          decision: e.request_id && {
            requestId: e.request_id,
            teeVerified: e.tee_verified,
            accepted: e.accepted,
            rejectReason: e.reject_reason,
            model: e.model,
            latencyMs: e.latency_ms == null ? null : Number(e.latency_ms),
          },
        })),
      })
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
        receipts: Object.fromEntries(
          await Promise.all(
            intents.map(async (i) => [i.intentId, await flashReceipt(ctx, i)] as const),
          ),
        ),
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
