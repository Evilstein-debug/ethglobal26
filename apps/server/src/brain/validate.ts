/**
 * The model suggests, code decides. Pure validators for each decision type: parse the model's
 * JSON, reject anything outside the rules, clamp sizes to the owner's caps. Nothing here trusts
 * a number from the model without bounding it.
 */
import { z } from 'zod'
import type { LimitConfig, TwapConfig } from '../context'

export type Rejected = { ok: false; reason: string }

/** Parse a model's JSON output, tolerating a ```json fence around it. */
export function parseModelJson(output: string): unknown {
  const trimmed = output.trim()
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed)
  try {
    return JSON.parse(fenced ? fenced[1]! : trimmed)
  } catch {
    return undefined
  }
}

const num = z.union([
  z.number(),
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .transform(Number),
])
const rationale = z
  .string()
  .max(2000)
  .catch('')
  .transform((s) => s.slice(0, 500))

// ── Trade ───────────────────────────────────────────────────────────────────────────────

const tradeOutput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('hold'), rationale }),
  z.object({
    action: z.literal('buy'),
    sizeQuote: num,
    stopPrice: num,
    targetPrice: num,
    rationale,
    /** How to enter: one market buy (default), a TWAP in tranches, or a limit buy that waits. */
    style: z.string().optional().catch(undefined),
    durationMinutes: num.optional().catch(undefined),
    buckets: num.optional().catch(undefined),
    limitPrice: num.optional().catch(undefined),
    waitMinutes: num.optional().catch(undefined),
    // Fields the model must not try to set; present → checked below, never used.
    asset: z.string().optional(),
    side: z.string().optional(),
  }),
])

export type TradeLimits = {
  /** Live USD price from Flash, never from the model. */
  livePrice: number
  /** Max USDC base units for this trade: min(perTradeCap, remaining entry budget). */
  maxSize: number
  minTrade: number
  /** Stop distance bounds, as fractions of price (e.g. 0.003 = 0.3%). */
  minRiskPct: number
  maxRiskPct: number
  /** Take-profit distance bounds; minTpPct must cover round-trip fees. */
  minTpPct: number
  maxTpPct: number
  /** Minimum reward / risk. */
  minRewardRisk: number
  /** What a TWAP entry may look like. */
  twap: TwapConfig
  /** What a limit entry may look like. */
  limit: LimitConfig
}

export type EntryPlan =
  | { style: 'twap'; durationSeconds: number; buckets: number }
  | { style: 'limit'; limitPrice: string; expireSeconds: number }

export type TradeDecision =
  | { ok: true; action: 'hold'; rationale: string }
  | {
      ok: true
      action: 'buy'
      /** USDC base units. */
      size: number
      sizeQuote: string
      stopPrice: string
      targetPrice: string
      entryRefPrice: string
      clamped: boolean
      rationale: string
      /** Set for a TWAP or limit entry: committed with the intent. Absent = one market buy. */
      execution?: EntryPlan
    }

export function validateTrade(raw: unknown, limits: TradeLimits): TradeDecision | Rejected {
  const parsed = tradeOutput.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: 'invalid_schema' }
  const d = parsed.data
  if (d.action === 'hold') return { ok: true, action: 'hold', rationale: d.rationale }
  if (
    d.asset !== undefined &&
    d.asset.toUpperCase() !== 'WETH' &&
    d.asset.toUpperCase() !== 'ETH'
  ) {
    return { ok: false, reason: 'asset_not_allowed' }
  }
  if (d.side !== undefined && !['long', 'buy'].includes(d.side.toLowerCase()))
    return { ok: false, reason: 'short_not_allowed' }

  if (d.style !== undefined && !['market', 'twap', 'limit'].includes(d.style))
    return { ok: false, reason: 'unknown_entry_style' }
  const p = limits.livePrice
  if (!(p > 0)) return { ok: false, reason: 'no_live_price' }
  const { stopPrice: sl, targetPrice: tp } = d

  // A limit buy enters at its limit, which must sit a bounded distance below the live price.
  // Everything about the bracket is then measured from the limit, not from the live price.
  let entry = p
  let limitPlan: { limitPrice: string; expireSeconds: number } | undefined
  if (d.style === 'limit') {
    const l = limits.limit
    const lp = d.limitPrice ?? NaN
    if (!(lp > 0)) return { ok: false, reason: 'limit_price_missing' }
    const dip = (p - lp) / p
    if (!(dip >= l.minDipPct && dip <= l.maxDipPct))
      return { ok: false, reason: 'limit_out_of_range' }
    const expireSeconds = Math.round((d.waitMinutes ?? NaN) * 60)
    if (!(expireSeconds >= l.minWaitSeconds && expireSeconds <= l.maxWaitSeconds))
      return { ok: false, reason: 'limit_wait_out_of_range' }
    // The committed prices are rounded to cents; the order of the levels must survive that.
    if (!(
      Number(sl.toFixed(2)) < Number(lp.toFixed(2)) && Number(lp.toFixed(2)) < Number(tp.toFixed(2))
    ))
      return { ok: false, reason: 'prices_not_bracketing_entry' }
    if (!(Number(lp.toFixed(2)) < Number(p.toFixed(2))))
      return { ok: false, reason: 'limit_out_of_range' }
    entry = lp
    limitPlan = { limitPrice: lp.toFixed(2), expireSeconds }
  }
  if (!(sl > 0 && tp > 0) || !(sl < entry && entry < tp))
    return { ok: false, reason: 'prices_not_bracketing_entry' }
  const risk = (entry - sl) / entry
  const reward = (tp - entry) / entry
  if (risk < limits.minRiskPct || risk > limits.maxRiskPct)
    return { ok: false, reason: 'stop_out_of_range' }
  if (reward < limits.minTpPct || reward > limits.maxTpPct)
    return { ok: false, reason: 'target_out_of_range' }
  if (reward / risk < limits.minRewardRisk) return { ok: false, reason: 'reward_risk_too_low' }

  if (!(d.sizeQuote > 0)) return { ok: false, reason: 'invalid_size' }
  const asked = Math.floor(d.sizeQuote * 1e6)
  const size = Math.min(asked, limits.maxSize)
  if (size < limits.minTrade) return { ok: false, reason: 'size_too_small' }

  // A TWAP's schedule is bounded by code: the model picks inside the range or is rejected.
  let execution: EntryPlan | undefined = limitPlan ? { style: 'limit', ...limitPlan } : undefined
  if (d.style === 'twap') {
    const t = limits.twap
    const durationSeconds = Math.round((d.durationMinutes ?? NaN) * 60)
    const buckets = d.buckets ?? NaN
    if (!(durationSeconds >= t.minSeconds && durationSeconds <= t.maxSeconds))
      return { ok: false, reason: 'twap_duration_out_of_range' }
    if (!Number.isInteger(buckets) || buckets < t.minBuckets || buckets > t.maxBuckets)
      return { ok: false, reason: 'twap_buckets_out_of_range' }
    if (size / buckets < t.minSlice) return { ok: false, reason: 'twap_slice_too_small' }
    execution = { style: 'twap', durationSeconds, buckets }
  }
  return {
    ok: true,
    action: 'buy',
    size,
    sizeQuote: (size / 1e6).toFixed(6).replace(/\.?0+$/, ''),
    stopPrice: sl.toFixed(2),
    targetPrice: tp.toFixed(2),
    entryRefPrice: p.toFixed(2),
    clamped: size !== asked,
    rationale: d.rationale,
    ...(execution ? { execution } : {}),
  }
}

// ── Predictions ─────────────────────────────────────────────────────────────────────────

const predictionItem = z.object({
  entryId: num,
  side: z.enum(['YES', 'NO', 'yes', 'no']).transform((s) => s.toUpperCase() as 'YES' | 'NO'),
  probYesBps: num.optional(),
  probabilityYes: num.optional(),
  rationale,
})
const predictionsOutput = z.object({ predictions: z.array(z.unknown()).max(100) })

export type PredictionDecision = {
  entryId: number
  side: 'YES' | 'NO'
  probYesBps: number
  rationale: string
}

/**
 * Keep only predictions on entries we offered (never the agent's own human's entries), with a
 * probability that agrees with the side, at most `maxCount`, one per entry.
 */
export function validatePredictions(
  raw: unknown,
  opts: { offered: Set<number>; maxCount: number },
) {
  const parsed = predictionsOutput.safeParse(raw)
  if (!parsed.success) return { ok: false as const, reason: 'invalid_schema' }
  const accepted: PredictionDecision[] = []
  const rejected: { item: unknown; reason: string }[] = []
  const seen = new Set<number>()
  for (const item of parsed.data.predictions) {
    const p = predictionItem.safeParse(item)
    if (!p.success) {
      rejected.push({ item, reason: 'invalid_item' })
      continue
    }
    const { entryId, side } = p.data
    const bps =
      p.data.probYesBps !== undefined
        ? p.data.probYesBps
        : p.data.probabilityYes !== undefined
          ? p.data.probabilityYes * 10_000
          : NaN
    const prob = Math.round(bps)
    if (!Number.isInteger(entryId) || !opts.offered.has(entryId))
      rejected.push({ item, reason: 'entry_not_offered' })
    else if (seen.has(entryId)) rejected.push({ item, reason: 'duplicate_entry' })
    else if (!(prob >= 0 && prob <= 10_000)) rejected.push({ item, reason: 'invalid_probability' })
    else if (side === 'YES' ? prob < 5000 : prob > 5000)
      rejected.push({ item, reason: 'side_disagrees_with_probability' })
    else if (accepted.length >= opts.maxCount)
      rejected.push({ item, reason: 'over_prediction_limit' })
    else {
      seen.add(entryId)
      accepted.push({ entryId, side, probYesBps: prob, rationale: p.data.rationale })
    }
  }
  return { ok: true as const, accepted, rejected }
}

// ── The agent's choice ──────────────────────────────────────────────────────────────────

const actionOutput = z.object({ action: z.string().toLowerCase(), rationale })

export type ThinkDecision =
  | { ok: true; action: 'wait'; rationale: string }
  | Extract<TradeDecision, { action: 'buy' }>
  | { ok: true; action: 'predict'; accepted: PredictionDecision[]; rejected: { reason: string }[] }

/**
 * The model picks its own action, but only among what's open to it right now: a buy when trading
 * is blocked, or a prediction when nothing is on offer, is rejected here.
 */
export function validateThink(
  raw: unknown,
  opts: {
    trade: TradeLimits | null
    predict: { offered: Set<number>; maxCount: number } | null
  },
): ThinkDecision | Rejected {
  const parsed = actionOutput.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: 'invalid_schema' }
  const { action, rationale: why } = parsed.data
  if (action === 'wait' || action === 'hold') return { ok: true, action: 'wait', rationale: why }
  if (action === 'buy') {
    if (!opts.trade) return { ok: false, reason: 'trade_not_available' }
    const v = validateTrade(raw, opts.trade)
    return v.ok && v.action === 'hold' ? { ok: true, action: 'wait', rationale: why } : v
  }
  if (action === 'predict') {
    if (!opts.predict) return { ok: false, reason: 'predict_not_available' }
    const v = validatePredictions(raw, opts.predict)
    if (!v.ok) return v
    if (!v.accepted.length) return { ok: false, reason: 'no_valid_predictions' }
    return { ok: true, action: 'predict', accepted: v.accepted, rejected: v.rejected }
  }
  return { ok: false, reason: 'unknown_action' }
}
