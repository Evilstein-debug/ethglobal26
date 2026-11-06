/**
 * The model suggests, code decides. Pure validators for each decision type: parse the model's
 * JSON, reject anything outside the rules, clamp sizes to the owner's caps. Nothing here trusts
 * a number from the model without bounding it.
 */
import { z } from 'zod'

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

// ── Allocation ──────────────────────────────────────────────────────────────────────────

export const allocationOutput = z.object({
  trade: z.boolean(),
  tradeBudget: num.optional(),
  rationale,
})

export type AllocationLimits = {
  /** USDC base units. */
  roundTradeCap: number
  balance: number
  minTrade: number
}
export type AllocationDecision = {
  ok: true
  trade: boolean
  budget: number
  clamped: boolean
  rationale: string
}

export function validateAllocation(
  raw: unknown,
  limits: AllocationLimits,
): AllocationDecision | Rejected {
  const parsed = allocationOutput.safeParse(raw)
  if (!parsed.success) return { ok: false, reason: 'invalid_schema' }
  const { trade, tradeBudget, rationale: why } = parsed.data
  if (!trade) return { ok: true, trade: false, budget: 0, clamped: false, rationale: why }
  if (tradeBudget === undefined || !Number.isFinite(tradeBudget) || tradeBudget <= 0) {
    return { ok: false, reason: 'invalid_budget' }
  }
  const asked = Math.floor(tradeBudget * 1e6)
  const max = Math.min(limits.roundTradeCap, limits.balance)
  const budget = Math.min(asked, max)
  if (budget < limits.minTrade)
    return {
      ok: true,
      trade: false,
      budget: 0,
      clamped: true,
      rationale: `${why} [budget below minimum trade]`,
    }
  return { ok: true, trade: true, budget, clamped: budget !== asked, rationale: why }
}

// ── Trade ───────────────────────────────────────────────────────────────────────────────

const tradeOutput = z.discriminatedUnion('action', [
  z.object({ action: z.literal('hold'), rationale }),
  z.object({
    action: z.literal('buy'),
    sizeQuote: num,
    stopPrice: num,
    targetPrice: num,
    rationale,
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
}

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

  const p = limits.livePrice
  if (!(p > 0)) return { ok: false, reason: 'no_live_price' }
  const { stopPrice: sl, targetPrice: tp } = d
  if (!(sl > 0 && tp > 0) || !(sl < p && p < tp))
    return { ok: false, reason: 'prices_not_bracketing_entry' }
  const risk = (p - sl) / p
  const reward = (tp - p) / p
  if (risk < limits.minRiskPct || risk > limits.maxRiskPct)
    return { ok: false, reason: 'stop_out_of_range' }
  if (reward < limits.minTpPct || reward > limits.maxTpPct)
    return { ok: false, reason: 'target_out_of_range' }
  if (reward / risk < limits.minRewardRisk) return { ok: false, reason: 'reward_risk_too_low' }

  if (!(d.sizeQuote > 0)) return { ok: false, reason: 'invalid_size' }
  const asked = Math.floor(d.sizeQuote * 1e6)
  const size = Math.min(asked, limits.maxSize)
  if (size < limits.minTrade) return { ok: false, reason: 'size_too_small' }
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
