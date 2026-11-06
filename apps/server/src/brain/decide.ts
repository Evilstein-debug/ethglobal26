/**
 * One agent, one thought: gather everything the agent can see → ask the model (0G) what to do →
 * validate in code → record the call in `decisions` (accepted or rejected, with the 0G trace) →
 * act. The model chooses freely between buying, predicting and waiting; plain code decides what's
 * on offer and enforces the limits. Every step lands in the agent's public activity feed.
 */
import { randomUUID } from 'node:crypto'
import { ZeroGError, type LLMResult } from '@starter/zerog'
import { canonicalJson, idHash } from '@starter/shared/canonical'
import { arenaAbi } from '@starter/shared/generated'
import { predictionSchema } from '@starter/shared/schemas'
import { and, eq, sql } from 'drizzle-orm'
import { encodeFunctionData, formatEther, formatUnits, getAddress, zeroHash, type Hash } from 'viem'
import type { AppContext } from '../context'
import { queryRows, schema } from '../db'
import { executeTrade, newIntentId, type TradeResult } from '../execution/trade'
import { authorizePrediction, authorizeTrade } from '../policy/authorize'
import { reserveMarket, settleEmptyMarket, type MarketConfig } from '../rounds/scheduler'
import { logActivity, setStatus, type AgentState } from '../services/activity'
import { agentSigner, balancesOf } from '../services/agents'
import { dataBlock, stepsBlock, THINK_SYSTEM, type Step } from './prompts'
import { isToolName, runTool } from './tools'
import { parseModelJson, validateThink, type PredictionDecision } from './validate'

type AgentRow = typeof schema.agents.$inferSelect
type Kind = 'think' | 'trade' | 'prediction'
const DAY_MS = 86_400_000

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
  kind: Kind,
  system: string,
  data: unknown,
  /** Text after the DATA block, e.g. the steps taken so far in this thought. */
  extra = '',
) {
  if (!ctx.llm) return { ok: false as const, reason: 'llm_not_configured' }
  try {
    const result = await ctx.llm.complete({
      system,
      user: dataBlock(data) + extra,
      maxTokens: 4000,
    })
    return { ok: true as const, result, parsed: parseModelJson(result.output) }
  } catch (err) {
    if (err instanceof ZeroGError && err.trace?.requestId) {
      await record(
        ctx,
        agentId,
        0,
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
        trades: stats.rounds,
        wins: stats.wins,
        losses: stats.losses,
        voids: stats.voids,
        pnlBpsTotal: stats.pnlBpsTotal,
      }
    : { trades: 0, wins: 0, losses: 0, voids: 0, pnlBpsTotal: 0 }
}

/** Markets this agent may predict on: window open, another human's, not predicted yet. */
async function openMarketsFor(ctx: AppContext, agent: AgentRow) {
  const rows = await queryRows<{
    id: number
    round_id: number
    onchain_entry_id: number
    trader_agent_id: string
    trader_name: string
    entry_ref_price: string
    stop_price: string
    target_price: string
    size_quote: string
    phase_ends_at: string
    closes_at: string | null
  }>(
    ctx.db,
    sql`select e.id, e.round_id, e.onchain_entry_id, e.trader_agent_id, t.name as trader_name,
               i.entry_ref_price, i.stop_price, i.target_price, i.size_quote,
               r.phase_ends_at, r.closes_at
        from round_entries e
        join rounds r on r.id = e.round_id
        join intents i on i.entry_id = e.id
        join agents t on t.id = e.trader_agent_id
        join owners o on o.wallet = t.owner_wallet
        where r.phase = 'PREDICTING' and r.phase_ends_at > ${ctx.now()}
          and e.outcome = 'PENDING' and e.onchain_entry_id is not null
          and o.human_id <> (select o2.human_id from agents a2 join owners o2 on o2.wallet = a2.owner_wallet where a2.id = ${agent.id})
          and not exists (select 1 from predictions p where p.entry_id = e.id and p.agent_id = ${agent.id})
        order by e.id`,
  )
  return Promise.all(
    rows.map(async (e) => ({
      local: e,
      view: {
        entryId: e.onchain_entry_id,
        trader: e.trader_name,
        asset: 'WETH',
        entryPriceUsd: Number(e.entry_ref_price),
        stopPriceUsd: Number(e.stop_price),
        targetPriceUsd: Number(e.target_price),
        sizeUsdc: Number(e.size_quote) / 1e6,
        secondsLeftToPredict: Math.round((Number(e.phase_ends_at) - ctx.now()) / 1000),
        history: await traderHistory(ctx, e.trader_agent_id),
      },
    })),
  )
}

async function openPosition(ctx: AppContext, agentId: string) {
  const [i] = await ctx.db
    .select()
    .from(schema.intents)
    .where(and(eq(schema.intents.agentId, agentId), eq(schema.intents.state, 'EXECUTED')))
    .limit(1)
  return (
    i && {
      asset: i.asset,
      entryPriceUsd: Number(i.entryRefPrice),
      stopPriceUsd: Number(i.stopPrice),
      targetPriceUsd: Number(i.targetPrice),
      sizeUsdc: i.sizeQuote / 1e6,
    }
  )
}

const REFUSED: Record<string, string> = {
  asset_risk_flagged: 'Flash flags WETH as risky right now, so it is not trading',
  position_open: 'Already holding a position',
  cooldown: 'Cooling down after its last trade',
  over_daily_cap: 'Reached its daily spending limit',
  insufficient_funds: 'Not enough USDC to trade',
  paused: 'Paused by its owner',
}

export type ThinkResult =
  | { action: 'skipped'; reason: string }
  | { action: 'unavailable' | 'rejected'; reason: string; decisionId?: string }
  | { action: 'wait'; decisionId: string }
  | { action: 'buy'; decisionId: string; trade: TradeResult }
  | { action: 'predict'; decisionId: string; outcomes: PredictionOutcome[] }

/** Run one thought for an agent, and say when it should think again. */
export async function think(
  ctx: AppContext,
  agent: AgentRow,
  cfg: MarketConfig,
): Promise<ThinkResult> {
  const next = { nextThinkAt: ctx.now() + cfg.thinkEveryMs }
  const stop = async (state: AgentState, detail: string): Promise<ThinkResult> => {
    await setStatus(ctx, agent.id, state, detail, next)
    return { action: 'skipped', reason: detail }
  }

  const policy = await policyOf(ctx, agent.id)
  const { usdc, eth } = await balancesOf(ctx, getAddress(agent.address))
  if (eth < cfg.minGasWei) {
    return stop(
      'needs_funds',
      `Needs ETH for gas: has ${formatEther(eth)} ETH, needs at least ${formatEther(cfg.minGasWei)}. Send ETH to ${agent.address}`,
    )
  }

  const trader = agent.mode !== 'predict'
  const predictor = agent.mode !== 'trade'
  const b = ctx.brain

  // What's open to the agent right now. The dry run applies every rule a real trade would.
  const gate = trader
    ? await authorizeTrade(
        ctx.db,
        { agentId: agent.id, roundId: 0, amount: b.minTrade, asset: 'WETH', ref: 'think' },
        usdc,
        ctx.now(),
        { dryRun: true, cooldownMs: b.tradeCooldownMs },
      )
    : null
  const [spent] = await queryRows<{ total: string | null }>(
    ctx.db,
    sql`select sum(amount) as total from spend_ledger where agent_id = ${agent.id} and created_at >= ${ctx.now() - DAY_MS} and status in ('reserved','settled')`,
  )
  const maxSize = Math.max(
    0,
    Math.min(policy.perTradeCap, policy.dailyCap - Number(spent?.total ?? 0), Number(usdc)),
  )
  const asset = trader && ctx.flash ? await ctx.flash.api.search('WETH', ctx.flash.chain, 1) : []
  const livePrice = Number(asset[0]?.price)
  // The risk flag is checked again by code at execution; asking here saves a pointless model call.
  const flagged = Boolean(asset[0]?.riskFlagged)
  const canTrade = Boolean(gate?.ok) && maxSize >= b.minTrade && livePrice > 0 && !flagged

  const [made] = await queryRows<{ n: string }>(
    ctx.db,
    sql`select count(*) as n from predictions where agent_id = ${agent.id} and created_at >= ${ctx.now() - DAY_MS}`,
  )
  const maxPredictions = Math.max(0, policy.predictionsPerDay - Number(made?.n ?? 0))
  const markets = predictor && maxPredictions > 0 ? await openMarketsFor(ctx, agent) : []
  const canPredict = markets.length > 0

  // Nothing it could do: don't spend a model call to find that out.
  if (!canTrade && !canPredict) {
    const reason = gate && !gate.ok ? gate.reason : undefined
    if (reason === 'position_open') {
      return stop('watching_position', 'Watching its open position')
    }
    if (reason === 'cooldown') return stop('cooling_down', REFUSED.cooldown!)
    if (trader && reason === 'insufficient_funds') {
      return stop(
        'needs_funds',
        `Needs USDC to trade: has ${formatUnits(usdc, 6)} USDC, needs at least ${formatUnits(BigInt(b.minTrade), 6)}. Send USDC to ${agent.address}`,
      )
    }
    if (trader && maxSize < b.minTrade) return stop('idle', REFUSED.over_daily_cap!)
    if (reason === 'paused') return stop('idle', REFUSED.paused!)
    if (trader && flagged) return stop('idle', REFUSED.asset_risk_flagged!)
    return stop('idle', 'No open markets to predict on')
  }

  const options = [
    canTrade && 'a trade',
    canPredict && `${markets.length} open market${markets.length > 1 ? 's' : ''}`,
  ].filter(Boolean)
  await setStatus(ctx, agent.id, 'thinking', `Considering ${options.join(' and ')}`)

  // A TWAP must finish well inside the hold limit, or it would still be buying when time is up.
  const twapLimits = {
    ...b.twap,
    maxSeconds: Math.min(b.twap.maxSeconds, Math.floor(cfg.maxHoldMs / 2000)),
  }
  const data = {
    you: {
      mode: agent.mode,
      balanceUsdc: Number(usdc) / 1e6,
      history: await traderHistory(ctx, agent.id),
    },
    position: (await openPosition(ctx, agent.id)) ?? null,
    actions: { trade: canTrade, predict: canPredict },
    // Only the live price is handed over. History, news and the agent's own past are tools it
    // chooses to call (brain/tools.ts), and every call shows up in the Live feed.
    market: { asset: 'WETH', livePriceUsd: livePrice || null },
    limits: {
      maxToolSteps: b.maxSteps,
      maxSizeUsdc: maxSize / 1e6,
      minRiskPct: b.minRiskPct,
      maxRiskPct: b.maxRiskPct,
      minTpPct: b.minTpPct,
      maxTpPct: b.maxTpPct,
      minRewardRisk: b.minRewardRisk,
      maxHoldMinutes: cfg.maxHoldMs / 60_000,
      maxPredictions,
      limit: {
        minDipPct: b.limit.minDipPct * 100,
        maxDipPct: b.limit.maxDipPct * 100,
        minWaitMinutes: b.limit.minWaitSeconds / 60,
        maxWaitMinutes: b.limit.maxWaitSeconds / 60,
      },
      twap: {
        minMinutes: twapLimits.minSeconds / 60,
        maxMinutes: twapLimits.maxSeconds / 60,
        minBuckets: twapLimits.minBuckets,
        maxBuckets: twapLimits.maxBuckets,
        minSliceUsdc: twapLimits.minSlice / 1e6,
        trimAtOrBelowPct: twapLimits.trimAtOrBelowBps / 100,
      },
    },
    openMarkets: markets.map((m) => m.view),
  }

  // Think → (ask for a tool → see the result → think again) → decide. Each step is its own model
  // call with its own 0G request ID, and its own rows in the feed.
  const steps: Step[] = []
  let res = await ask(ctx, agent.id, 'think', THINK_SYSTEM, data)
  for (;;) {
    if (!res.ok) {
      await setStatus(ctx, agent.id, 'error', `Model unavailable: ${res.reason}`, next)
      return { action: 'unavailable', reason: res.reason }
    }
    const out = (res.parsed ?? {}) as { thought?: unknown; tool?: unknown; args?: unknown }
    if (out.tool === undefined) break
    const thought =
      typeof out.thought === 'string' ? out.thought.slice(0, 300) : '(no thought given)'
    const stepNo = steps.length + 1
    const decisionId = await record(
      ctx,
      agent.id,
      0,
      'think',
      res.result,
      stepNo <= b.maxSteps,
      stepNo <= b.maxSteps ? 'tool_step' : 'too_many_steps',
    )
    await logActivity(ctx, agent.id, 'thought', thought, { decisionId })
    if (stepNo > b.maxSteps) {
      await setStatus(ctx, agent.id, 'idle', 'Asked for more tools than allowed', {
        ...next,
        silent: true,
      })
      await logActivity(ctx, agent.id, 'idle', 'Asked for more tools than allowed; no action taken')
      return { action: 'rejected', reason: 'too_many_steps', decisionId }
    }
    const argsText = JSON.stringify(out.args ?? {})
    await logActivity(ctx, agent.id, 'tool_call', `${String(out.tool)}(${argsText})`, {
      decisionId,
    })
    await setStatus(ctx, agent.id, 'thinking', `Step ${stepNo}: ${String(out.tool)}`, {
      silent: true,
    })
    const outcome = isToolName(out.tool)
      ? await runTool(ctx, agent.id, out.tool, out.args)
      : ({ ok: false, error: 'unknown_tool' } as const)
    const observation = outcome.ok ? outcome.text : JSON.stringify({ error: outcome.error })
    await logActivity(
      ctx,
      agent.id,
      'tool_result',
      outcome.ok ? observation.slice(0, 160) : `failed: ${outcome.error}`,
      { decisionId, detail: observation },
    )
    steps.push({ thought, tool: String(out.tool), args: out.args, observation })
    res = await ask(
      ctx,
      agent.id,
      'think',
      THINK_SYSTEM,
      data,
      stepsBlock(steps, steps.length >= b.maxSteps),
    )
  }

  // The model's own words for the final action: its "rationale", else its "thought".
  const final = res.parsed as Record<string, unknown> | undefined
  if (final && typeof final === 'object' && typeof final.thought === 'string') {
    if (typeof final.rationale !== 'string' || !final.rationale) final.rationale = final.thought
  }

  const v = validateThink(res.parsed, {
    trade: canTrade ? { livePrice, maxSize, ...b, twap: twapLimits } : null,
    predict: canPredict
      ? { offered: new Set(markets.map((m) => m.view.entryId)), maxCount: maxPredictions }
      : null,
  })
  if (!v.ok) {
    const decisionId = await record(ctx, agent.id, 0, 'think', res.result, false, v.reason)
    const why = `Guardrails rejected its decision: ${v.reason}`
    // Logged every time, even when the reason repeats: a rejection is never swallowed.
    await setStatus(ctx, agent.id, 'idle', why, { ...next, decisionId, silent: true })
    await logActivity(ctx, agent.id, 'idle', why, { decisionId })
    return { action: 'rejected', reason: v.reason, decisionId }
  }

  if (v.action === 'wait') {
    const decisionId = await record(ctx, agent.id, 0, 'think', res.result, true)
    // Logged every time: each wait carries fresh reasoning, so the feed must not dedupe it away.
    await setStatus(ctx, agent.id, 'idle', 'Decided to wait', { ...next, silent: true })
    await logActivity(ctx, agent.id, 'idle', 'Decided to wait', {
      rationale: v.rationale,
      decisionId,
    })
    return { action: 'wait', decisionId }
  }

  if (v.action === 'predict') {
    const note = v.rejected.length
      ? `items rejected: ${v.rejected.map((r) => r.reason).join(',')}`
      : undefined
    const decisionId = await record(ctx, agent.id, 0, 'prediction', res.result, true, note)
    const outcomes: PredictionOutcome[] = []
    for (const p of v.accepted) {
      const local = markets.find((m) => m.view.entryId === p.entryId)!
      await setStatus(
        ctx,
        agent.id,
        'predicting',
        `Predicting ${p.side} at ${p.probYesBps / 100}% on ${local.view.trader}'s trade`,
        { rationale: p.rationale, decisionId, entryId: local.local.id },
      )
      outcomes.push(
        await submitAgentPrediction(ctx, agent, {
          roundId: local.local.round_id,
          localEntryId: local.local.id,
          decision: p,
          requestId: res.result.requestId,
          model: res.result.model,
          decisionId,
        }),
      )
    }
    const sent = outcomes.filter((o) => o.status === 'submitted').length
    await setStatus(
      ctx,
      agent.id,
      'idle',
      `Submitted ${sent} of ${outcomes.length} predictions`,
      next,
    )
    return { action: 'predict', decisionId, outcomes }
  }

  const market = await reserveMarket(ctx, cfg)
  const decisionId = await record(ctx, agent.id, market.id, 'trade', res.result, true)
  await setStatus(
    ctx,
    agent.id,
    'trading',
    `${v.execution?.style === 'limit' ? `Placing a limit buy at ${v.execution.limitPrice} (market ${v.entryRefPrice}) of ${v.sizeQuote} USDC of WETH` : `Buying ${v.sizeQuote} USDC of WETH${v.execution?.style === 'twap' ? ` in ${v.execution.buckets} tranches over ${Math.round(v.execution.durationSeconds / 60)} min` : ''}`}, target ${v.targetPrice}, stop ${v.stopPrice}`,
    { rationale: v.rationale, decisionId },
  )
  const trade = await executeTrade(
    ctx,
    {
      version: 1,
      intentId: newIntentId(),
      roundId: market.id,
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
      ...(v.execution ? { execution: v.execution } : {}),
      createdAt: new Date(ctx.now()).toISOString(),
    },
    { decisionId },
  )
  if (trade.status === 'executed') {
    // The market loop broadcasts it: there's one place that opens markets, so no double opens.
    await setStatus(ctx, agent.id, 'watching_position', 'Watching its open position', next)
  } else if (trade.status === 'resting') {
    // Nothing is announced until the order fills; the market loop opens it then.
    await setStatus(
      ctx,
      agent.id,
      'watching_position',
      `Waiting for its limit buy to fill at ${trade.limitPrice}`,
      next,
    )
  } else {
    await settleEmptyMarket(ctx, market.id)
    const why = trade.status === 'denied' ? trade.reason : `${trade.reason} (recorded onchain)`
    await setStatus(ctx, agent.id, 'idle', `Trade did not go through: ${why}`, next)
  }
  return { action: 'buy', decisionId, trade }
}

export type PredictionOutcome = {
  entryId: number
  status: 'submitted' | 'denied' | 'failed'
  reason?: string
  tx?: Hash
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
