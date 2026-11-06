/**
 * Crowd-sized TWAP. A TWAP entry is one Flash order that buys in tranches over minutes. While it
 * runs, the predictors' view of the trade sets how much of it gets built: before each tranche is
 * due we read the mean probability they gave, and if it has fallen to the trim level we cancel the
 * remaining tranches. The position stays at what already filled, still protected by its bracket.
 *
 * It needs a TWAP because a market order is all or nothing; only tranches leave something to
 * decide. Cancelling signs the same single-order cancel message as any other cancel, so the signer
 * allowlist is unchanged.
 */
import { cancelMessage, TERMINAL_STATUSES, type GetOrderResponse } from '@starter/flash'
import { FUNDS_DRAINED_NOTE } from '@starter/shared/verify'
import { eq } from 'drizzle-orm'
import { getAddress } from 'viem'
import type { AppContext } from '../context'
import { schema } from '../db'
import { logActivity } from '../services/activity'
import { agentSigner, getAgent } from '../services/agents'
import { FUNDER_DRAINED, waitForTerminal } from './trade'

type Intent = typeof schema.intents.$inferSelect

/** Say so, once, when Flash itself ended an order because the wallet could no longer fund it. */
export async function noteFlashCancel(ctx: AppContext, intent: Intent, order: GetOrderResponse) {
  if (order.order.closeReason !== FUNDER_DRAINED || intent.flashNote) return
  await ctx.db
    .update(schema.intents)
    .set({ flashNote: FUNDS_DRAINED_NOTE, updatedAt: ctx.now() })
    .where(eq(schema.intents.intentId, intent.intentId))
  await logActivity(ctx, intent.agentId, 'flash', FUNDS_DRAINED_NOTE, {
    entryId: intent.entryId ?? undefined,
  })
}

/** Cancel a TWAP's remaining tranches (if any are left) and return the order as it ended. */
export async function stopTwap(ctx: AppContext, intent: Intent): Promise<GetOrderResponse | null> {
  const flash = ctx.flash
  if (!flash || intent.entryStyle !== 'twap' || !intent.flashOrderId) return null
  const agent = await getAgent(ctx, intent.agentId)
  const funder = getAddress(agent.address)
  let entry = await flash.api.getOrder(intent.flashOrderId, funder)
  if (!TERMINAL_STATUSES.includes(entry.order.status)) {
    const signature = await agentSigner(ctx, agent).signMessage(cancelMessage(intent.flashOrderId))
    await flash.api.cancelOrder(intent.flashOrderId, signature)
    entry = await waitForTerminal(flash, intent.flashOrderId, funder)
  }
  await noteFlashCancel(ctx, intent, entry)
  return entry
}

export type GovernResult = 'skipped' | 'waiting' | 'continued' | 'trimmed' | 'finished'

/** One look at a running TWAP: let it carry on, or cancel what is left. Safe to call every tick. */
export async function governTwap(ctx: AppContext, intentId: string): Promise<GovernResult> {
  const flash = ctx.flash
  const [intent] = await ctx.db
    .select()
    .from(schema.intents)
    .where(eq(schema.intents.intentId, intentId))
  if (
    !flash ||
    !intent ||
    intent.entryStyle !== 'twap' ||
    intent.state !== 'EXECUTED' ||
    !intent.flashOrderId
  )
    return 'skipped'
  const now = ctx.now()
  if (intent.twapNextCheckAt == null || now < intent.twapNextCheckAt) return 'skipped'

  const agent = await getAgent(ctx, intent.agentId)
  const entry = await flash.api.getOrder(intent.flashOrderId, getAddress(agent.address))
  const setNext = (at: number | null) =>
    ctx.db
      .update(schema.intents)
      .set({ twapNextCheckAt: at, updatedAt: now })
      .where(eq(schema.intents.intentId, intentId))
  if (TERMINAL_STATUSES.includes(entry.order.status)) {
    await noteFlashCancel(ctx, intent, entry)
    await setNext(null)
    return 'finished'
  }

  const total = entry.order.twapBucketCount ?? intent.twapBuckets ?? 0
  const built = entry.order.completedFillCount ?? 0
  const interval = Math.round(((intent.twapDurationSec ?? 0) * 1000) / Math.max(1, total))
  const votes = intent.entryId
    ? await ctx.db
        .select({ prob: schema.predictions.probYesBps })
        .from(schema.predictions)
        .where(eq(schema.predictions.entryId, intent.entryId))
    : []
  const { minVoters, trimAtOrBelowBps } = ctx.brain.twap
  const log = (message: string) =>
    logActivity(ctx, intent.agentId, 'twap', message, { entryId: intent.entryId ?? undefined })

  if (votes.length < minVoters) {
    await setNext(now + interval)
    await log(`Tranche ${built} of ${total} done. No predictors yet, so the rest carries on.`)
    return 'waiting'
  }
  const mean = Math.round(votes.reduce((s, v) => s + v.prob, 0) / votes.length)
  const pct = `${(mean / 100).toFixed(0)}% YES from ${votes.length} predictor${votes.length > 1 ? 's' : ''}`
  if (mean <= trimAtOrBelowBps) {
    await stopTwap(ctx, intent)
    await setNext(null)
    await log(
      `Tranche ${built} of ${total} done. The crowd is at ${pct}: cancelled the remaining ${total - built}. The position stays at what filled.`,
    )
    return 'trimmed'
  }
  await setNext(now + interval)
  await log(`Tranche ${built} of ${total} done. The crowd is at ${pct}: the rest goes ahead.`)
  return 'continued'
}
