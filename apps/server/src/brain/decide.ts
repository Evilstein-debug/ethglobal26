/**
 * The three decisions, each: gather data → ask the model (0G) → validate in code → record the
 * call in `decisions` (accepted or rejected, with the 0G trace) → act.
 *   - allocation (REGISTRATION): trade this round? with what budget?
 *   - trade (TRADING): long WETH with TP/SL, or hold → executeTrade
 *   - prediction (PREDICTING): YES/NO + probability per entry → Arena.predict
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ZeroGError, type LLMResult } from '@starter/zerog'
import { canonicalJson, idHash } from '@starter/shared/canonical'
import { arenaAbi } from '@starter/shared/generated'
import { predictionSchema } from '@starter/shared/schemas'
import { and, eq, sql } from 'drizzle-orm'
import { encodeFunctionData, getAddress, zeroHash, type Hash } from 'viem'
import type { AppContext } from '../context'
import { queryRows, schema } from '../db'
import { executeTrade, newIntentId, type TradeResult } from '../execution/trade'
import { authorizePrediction } from '../policy/authorize'
import { agentSigner, balancesOf } from '../services/agents'
import { ALLOCATION_SYSTEM, dataBlock, PREDICTION_SYSTEM, TRADE_SYSTEM } from './prompts'
import {
  parseModelJson,
  validateAllocation,
  validatePredictions,
  validateTrade,
  type PredictionDecision,
} from './validate'

type AgentRow = typeof schema.agents.$inferSelect
type Kind = 'allocation' | 'trade' | 'prediction'

const HEADLINES = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../fixtures/headlines.json'), 'utf8'),
) as {
  label: string
  items: string[]
}

async function record(
  ctx: AppContext,
  agentId: string,
  roundId: number,
  kind: Kind,
  trace: Pick<
    LLMResult,
    'requestId' | 'provider' | 'chatId' | 'model' | 'teeVerified' | 'latencyMs'
  > & { output: string },
  accepted: boolean,
  rejectReason?: string,
) {
  const id = randomUUID()
  await ctx.db.insert(schema.decisions).values({
    id,
    agentId,
    roundId,
    kind,
    model: trace.model,
    requestId: trace.requestId,
    provider: trace.provider,
    chatId: trace.chatId,
    teeVerified: trace.teeVerified,
    rawOutput: trace.output.slice(0, 20_000),
    accepted,
    rejectReason: rejectReason?.slice(0, 500) ?? null,
    latencyMs: trace.latencyMs,
  })
  return id
}

/** Ask the model. A failed 0G call that still has a request ID is recorded as rejected. */
async function ask(
  ctx: AppContext,
  agentId: string,
  roundId: number,
  kind: Kind,
  system: string,
  data: unknown,
) {
  if (!ctx.llm) return { ok: false as const, reason: 'llm_not_configured' }
  try {
    const result = await ctx.llm.complete({ system, user: dataBlock(data) })
    return { ok: true as const, result, parsed: parseModelJson(result.output) }
  } catch (err) {
    if (err instanceof ZeroGError && err.trace?.requestId) {
      await record(
        ctx,
        agentId,
        roundId,
        kind,
        { ...(err.trace as LLMResult), output: '' },
        false,
        err.code,
      )
    }
    console.warn(
      `[brain] ${kind} call failed for ${agentId}:`,
      err instanceof Error ? err.message : err,
    )
    return { ok: false as const, reason: err instanceof ZeroGError ? err.code : 'llm_error' }
  }
}

async function policyOf(ctx: AppContext, agentId: string) {
  const [p] = await ctx.db
    .select()
    .from(schema.policies)
    .where(eq(schema.policies.agentId, agentId))
  if (!p) throw new Error(`no policy for ${agentId}`)
  return p
}

async function traderHistory(ctx: AppContext, agentId: string) {
  const [stats] = await ctx.db
    .select()
    .from(schema.agentStats)
    .where(
      and(
        eq(schema.agentStats.agentId, agentId),
        eq(schema.agentStats.role, 'trader'),
        eq(schema.agentStats.replay, false),
      ),
    )
  return stats
    ? {
        rounds: stats.rounds,
        wins: stats.wins,
        losses: stats.losses,
        voids: stats.voids,
        pnlBpsTotal: stats.pnlBpsTotal,
      }
    : { rounds: 0, wins: 0, losses: 0, voids: 0, pnlBpsTotal: 0 }
}

// ── Allocation ──────────────────────────────────────────────────────────────────────────

export async function decideAllocation(ctx: AppContext, agent: AgentRow, roundId: number) {
  const policy = await policyOf(ctx, agent.id)
  const { usdc } = await balancesOf(ctx, getAddress(agent.address))
  const data = {
    round: roundId,
    balanceUsdc: Number(usdc) / 1e6,
    limits: { roundTradeCap: policy.perTradeCap / 1e6, perTradeCap: policy.perTradeCap / 1e6 },
    history: await traderHistory(ctx, agent.id),
  }
  const res = await ask(ctx, agent.id, roundId, 'allocation', ALLOCATION_SYSTEM, data)
  if (!res.ok) return { trade: false as const, reason: res.reason }
  const v = validateAllocation(res.parsed, {
    roundTradeCap: policy.perTradeCap,
    balance: Number(usdc),
    minTrade: ctx.brain.minTrade,
  })
  const decisionId = await record(
    ctx,
    agent.id,
    roundId,
    'allocation',
    res.result,
    v.ok,
    v.ok ? undefined : v.reason,
  )
  if (!v.ok) return { trade: false as const, reason: v.reason, decisionId }
  return {
    trade: v.trade,
    budget: v.budget,
    decisionId,
    requestId: res.result.requestId,
    rationale: v.rationale,
  }
}

// ── Trade ───────────────────────────────────────────────────────────────────────────────

export type TradeDecisionResult =
  | { action: 'hold'; decisionId: string }
  | { action: 'rejected' | 'unavailable'; reason: string; decisionId?: string }
  | { action: 'buy'; decisionId: string; trade: TradeResult }

export async function decideTrade(
  ctx: AppContext,
  agent: AgentRow,
  opts: { roundId: number; entryId: number | null; budget: number; roundEndsAt: number },
): Promise<TradeDecisionResult> {
  if (!ctx.flash) return { action: 'unavailable', reason: 'flash_not_configured' }
  const [asset] = await ctx.flash.api.search('WETH', ctx.flash.chain, 1)
  const livePrice = Number(asset?.price)
  if (!(livePrice > 0)) return { action: 'unavailable', reason: 'price_unavailable' }

  const policy = await policyOf(ctx, agent.id)
  const [spent] = await queryRows<{ total: string | null }>(
    ctx.db,
    sql`select sum(amount) as total from spend_ledger where agent_id = ${agent.id} and round_id = ${opts.roundId} and status in ('reserved','settled')`,
  )
  const maxSize = Math.max(0, Math.min(policy.perTradeCap, opts.budget - Number(spent?.total ?? 0)))
  const b = ctx.brain
  const data = {
    round: opts.roundId,
    roundEndsAt: new Date(opts.roundEndsAt).toISOString(),
    asset: 'WETH',
    livePriceUsd: livePrice,
    limits: {
      maxSizeUsdc: maxSize / 1e6,
      minRiskPct: b.minRiskPct,
      maxRiskPct: b.maxRiskPct,
      minTpPct: b.minTpPct,
      maxTpPct: b.maxTpPct,
      minRewardRisk: b.minRewardRisk,
    },
    headlines: HEADLINES,
    history: await traderHistory(ctx, agent.id),
  }
  const res = await ask(ctx, agent.id, opts.roundId, 'trade', TRADE_SYSTEM, data)
  if (!res.ok) return { action: 'unavailable', reason: res.reason }
  const v = validateTrade(res.parsed, { livePrice, maxSize, ...b })
  const decisionId = await record(
    ctx,
    agent.id,
    opts.roundId,
    'trade',
    res.result,
    v.ok,
    v.ok ? undefined : v.reason,
  )
  if (!v.ok) return { action: 'rejected', reason: v.reason, decisionId }
  if (v.action === 'hold') return { action: 'hold', decisionId }

  const trade = await executeTrade(
    ctx,
    {
      version: 1,
      intentId: newIntentId(),
      roundId: opts.roundId,
      agentAddress: getAddress(agent.address),
      asset: 'WETH',
      side: 'long',
      entryRefPrice: v.entryRefPrice,
      sizeQuote: v.sizeQuote,
      orderType: 'bracket',
      stopPrice: v.stopPrice,
      targetPrice: v.targetPrice,
      rationale: v.rationale,
      zeroG: { requestId: res.result.requestId, model: res.result.model },
      createdAt: new Date(ctx.now()).toISOString(),
    },
    { entryId: opts.entryId, decisionId },
  )
  return { action: 'buy', decisionId, trade }
}

// ── Predictions ─────────────────────────────────────────────────────────────────────────

export type PredictionOutcome = {
  entryId: number
  status: 'submitted' | 'denied' | 'failed'
  reason?: string
  tx?: Hash
}

export async function decidePredictions(ctx: AppContext, agent: AgentRow, roundId: number) {
  const policy = await policyOf(ctx, agent.id)
  // Offer only open entries of OTHER humans (the contract would revert on our own anyway).
  const offered = await queryRows<{
    id: number
    onchain_entry_id: number
    trader_agent_id: string
    trader_name: string
  }>(
    ctx.db,
    sql`select e.id, e.onchain_entry_id, e.trader_agent_id, t.name as trader_name
        from round_entries e
        join agents t on t.id = e.trader_agent_id
        join owners o on o.wallet = t.owner_wallet
        where e.round_id = ${roundId} and e.outcome = 'PENDING' and e.onchain_entry_id is not null
          and o.human_id <> (select o2.human_id from agents a2 join owners o2 on o2.wallet = a2.owner_wallet where a2.id = ${agent.id})`,
  )
  const [made] = await queryRows<{ n: string }>(
    ctx.db,
    sql`select count(*) as n from predictions where agent_id = ${agent.id} and created_at >= ${ctx.now() - 86_400_000}`,
  )
  const maxCount = Math.max(0, policy.predictionsPerDay - Number(made?.n ?? 0))
  if (offered.length === 0 || maxCount === 0)
    return {
      decisionId: undefined,
      outcomes: [] as PredictionOutcome[],
      reason: 'nothing_to_predict',
    }

  const entries = await Promise.all(
    offered.map(async (e) => ({
      entryId: e.onchain_entry_id,
      trader: e.trader_name,
      history: await traderHistory(ctx, e.trader_agent_id),
    })),
  )
  const res = await ask(ctx, agent.id, roundId, 'prediction', PREDICTION_SYSTEM, {
    round: roundId,
    entries,
    limits: { maxPredictions: maxCount },
  })
  if (!res.ok) return { decisionId: undefined, outcomes: [], reason: res.reason }
  const v = validatePredictions(res.parsed, {
    offered: new Set(offered.map((e) => e.onchain_entry_id)),
    maxCount,
  })
  const rejectNote = v.ok
    ? v.rejected.length
      ? `items rejected: ${v.rejected.map((r) => r.reason).join(',')}`
      : undefined
    : v.reason
  const decisionId = await record(
    ctx,
    agent.id,
    roundId,
    'prediction',
    res.result,
    v.ok,
    rejectNote,
  )
  if (!v.ok) return { decisionId, outcomes: [], reason: v.reason }

  const outcomes: PredictionOutcome[] = []
  for (const p of v.accepted) {
    const local = offered.find((e) => e.onchain_entry_id === p.entryId)!
    outcomes.push(
      await submitAgentPrediction(ctx, agent, {
        roundId,
        localEntryId: local.id,
        decision: p,
        requestId: res.result.requestId,
        model: res.result.model,
        decisionId,
      }),
    )
  }
  return { decisionId, outcomes }
}

/** Gate, sign Arena.predict from the agent wallet, then store the canonical prediction. */
export async function submitAgentPrediction(
  ctx: AppContext,
  agent: AgentRow,
  args: {
    roundId: number
    localEntryId: number
    decision: PredictionDecision
    requestId: string
    model: string
    decisionId: string
  },
): Promise<PredictionOutcome> {
  const { decision } = args
  const gate = await authorizePrediction(
    ctx.db,
    { agentId: agent.id, entryId: args.localEntryId },
    ctx.now(),
  )
  if (!gate.ok) return { entryId: decision.entryId, status: 'denied', reason: gate.reason }

  const prediction = predictionSchema.parse({
    version: 1,
    predictionId: randomUUID(),
    roundId: args.roundId,
    entryId: decision.entryId,
    predictorKind: 'agent',
    predictor: getAddress(agent.address),
    side: decision.side,
    probYesBps: decision.probYesBps,
    rationale: decision.rationale,
    zeroG: { requestId: args.requestId, model: args.model },
    createdAt: new Date(ctx.now()).toISOString(),
  })
  try {
    const signer = agentSigner(ctx, agent)
    const hash = await signer.sendTransaction({
      to: ctx.contracts.arena,
      data: encodeFunctionData({
        abi: arenaAbi,
        functionName: 'predict',
        args: [
          BigInt(decision.entryId),
          decision.side === 'YES',
          decision.probYesBps,
          args.requestId ? idHash(args.requestId) : zeroHash,
        ],
      }),
    })
    const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success')
      return { entryId: decision.entryId, status: 'failed', reason: `reverted ${hash}` }
    await ctx.db.insert(schema.predictions).values({
      predictionId: prediction.predictionId,
      roundId: args.roundId,
      entryId: args.localEntryId,
      predictorKind: 'agent',
      predictorAddress: agent.address.toLowerCase(),
      agentId: agent.id,
      side: prediction.side,
      probYesBps: prediction.probYesBps,
      canonicalJson: canonicalJson(prediction),
      decisionId: args.decisionId,
      predictTx: hash,
      createdAt: ctx.now(),
    })
    return { entryId: decision.entryId, status: 'submitted', tx: hash }
  } catch (err) {
    return {
      entryId: decision.entryId,
      status: 'failed',
      reason: err instanceof Error ? err.message.slice(0, 300) : String(err),
    }
  }
}
