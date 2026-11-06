/**
 * Canonical records we hash and commit onchain (see canonical.ts). These schemas check the
 * *shape and internal consistency* of a record. Policy limits (caps, budgets, phases) are
 * enforced by the policy engine, never here, and never by the model.
 *
 * Flash is spot-only, so a trade is always long: a market buy of the asset with USDC plus an
 * attached take-profit / stop-loss bracket (CLAUDE.md, "Doc findings").
 */
import { isAddress, parseUnits, type Address } from 'viem'
import { z } from 'zod'
import { TRADE_ASSETS } from './tokens'

/** Decimal string with up to 18 fractional digits, e.g. "3000.25". No sign, no exponent. */
const DECIMAL_RE = /^\d+(\.\d{1,18})?$/

export const decimalString = z.string().regex(DECIMAL_RE, 'expected a decimal string like "12.34"')

export const address = z
  .string()
  .refine((v) => isAddress(v, { strict: false }), 'expected a 0x address')
  .transform((v) => v as Address)

/** Compare two decimal strings exactly (no float rounding). */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const x = parseUnits(a, 18)
  const y = parseUnits(b, 18)
  return x < y ? -1 : x > y ? 1 : 0
}

export const zeroGRef = z.object({
  /** x_0g_trace.request_id from the 0G Router response. */
  requestId: z.string().min(1).max(200),
  model: z.string().min(1).max(100),
})

// zod 4 runs refinements even after the regex fails, so re-check the format before parsing.
const positiveDecimal = decimalString.refine(
  (v) => DECIMAL_RE.test(v) && compareDecimal(v, '0') > 0,
  'must be > 0',
)

export const tradeIntentSchema = z
  .object({
    version: z.literal(1),
    intentId: z.uuid(),
    roundId: z.number().int().nonnegative(),
    agentAddress: address,
    asset: z.enum(TRADE_ASSETS),
    side: z.literal('long'),
    /** USD reference price of the asset when the decision was made. */
    entryRefPrice: positiveDecimal,
    /** USDC to spend on the entry. */
    sizeQuote: positiveDecimal,
    orderType: z.literal('bracket'),
    /** Stop-loss trigger, USD. Must be below entryRefPrice. */
    stopPrice: positiveDecimal,
    /** Take-profit trigger, USD. Must be above entryRefPrice. */
    targetPrice: positiveDecimal,
    rationale: z.string().max(500),
    zeroG: zeroGRef,
    /**
     * How the entry is built. Absent = one market buy. The plan is committed with the intent, so
     * the schedule or the price level is on record before anything is sent. Committed hashes of
     * older intents don't change.
     */
    execution: z
      .discriminatedUnion('style', [
        z
          .object({
            style: z.literal('twap'),
            /** Total seconds. Flash enforces its own minimum (300); the server config stays above it. */
            durationSeconds: z.number().int().min(30),
            buckets: z.number().int().min(2).max(24),
          })
          .strict(),
        z
          .object({
            style: z.literal('limit'),
            /** USD price the buy rests at. Must be below entryRefPrice. */
            limitPrice: positiveDecimal,
            /** How long the order may rest before it is cancelled unfilled. */
            expireSeconds: z.number().int().min(30),
          })
          .strict(),
      ])
      .optional(),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((intent, ctx) => {
    const prices = [intent.entryRefPrice, intent.stopPrice, intent.targetPrice]
    if (!prices.every((p) => typeof p === 'string' && DECIMAL_RE.test(p))) return // reported above
    // A limit buy enters at its limit price, so the bracket is measured from there.
    const limit = intent.execution?.style === 'limit' ? intent.execution.limitPrice : null
    if (limit !== null) {
      if (!DECIMAL_RE.test(limit)) return
      if (compareDecimal(limit, intent.entryRefPrice) >= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['execution', 'limitPrice'],
          message: 'limit must be below the reference price',
        })
      }
      if (compareDecimal(intent.stopPrice, limit) >= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['stopPrice'],
          message: 'stop must be below the limit',
        })
      }
      if (compareDecimal(intent.targetPrice, limit) <= 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['targetPrice'],
          message: 'target must be above the limit',
        })
      }
      return
    }
    if (compareDecimal(intent.stopPrice, intent.entryRefPrice) >= 0) {
      ctx.addIssue({ code: 'custom', path: ['stopPrice'], message: 'stop must be below entry' })
    }
    if (compareDecimal(intent.targetPrice, intent.entryRefPrice) <= 0) {
      ctx.addIssue({ code: 'custom', path: ['targetPrice'], message: 'target must be above entry' })
    }
  })
export type TradeIntent = z.infer<typeof tradeIntentSchema>

/**
 * A free prediction (no money staked) on a round entry: "will this trader end the round with
 * positive realized PnL?". probYesBps is the predictor's probability of YES in basis points;
 * scoring uses it (Brier), and `side` must agree with it.
 */
export const predictionSchema = z
  .object({
    version: z.literal(1),
    predictionId: z.uuid(),
    roundId: z.number().int().nonnegative(),
    /** Onchain entry id in Arena. */
    entryId: z.number().int().nonnegative(),
    predictorKind: z.enum(['agent', 'owner']),
    predictor: address,
    side: z.enum(['YES', 'NO']),
    probYesBps: z.number().int().min(0).max(10_000),
    rationale: z.string().max(500),
    /** Required for agent predictions (made by a 0G model); null for an owner's manual pick. */
    zeroG: zeroGRef.nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.side === 'YES' ? p.probYesBps < 5_000 : p.probYesBps > 5_000) {
      ctx.addIssue({ code: 'custom', path: ['side'], message: 'side disagrees with probYesBps' })
    }
    if (p.predictorKind === 'agent' && !p.zeroG) {
      ctx.addIssue({ code: 'custom', path: ['zeroG'], message: 'agent predictions need a 0G ref' })
    }
    if (p.predictorKind === 'owner' && p.zeroG) {
      ctx.addIssue({ code: 'custom', path: ['zeroG'], message: 'owner picks have no 0G ref' })
    }
  })
export type Prediction = z.infer<typeof predictionSchema>
