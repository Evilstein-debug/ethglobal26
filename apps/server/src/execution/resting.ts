/**
 * Finishing a limit entry. The order was committed and placed with Flash, which watches the price
 * and fills it if the market reaches the limit. Nothing about the market is announced until then:
 * the trade opens as a prediction market only once it has filled, exactly like any other entry.
 *
 * Every commit still ends onchain as executed or failed:
 *   filled (fully, or partly before the cancel) → recordExecution with the fill transaction
 *   expired / cancelled / rejected with no fill → recordFailure with a reason code, budget released
 * A failed record is retried on the next tick, so a hiccup never strands a commit.
 */
import { cancelMessage, TERMINAL_STATUSES, type GetOrderResponse } from '@starter/flash'
import { tradeLogAbi } from '@starter/shared/generated'
import { FUNDS_DRAINED_NOTE } from '@starter/shared/verify'
import { USDC_DECIMALS } from '@starter/shared/tokens'
import { and, eq } from 'drizzle-orm'
import { encodeFunctionData, getAddress, isHex, parseUnits, type Hex } from 'viem'
import type { AppContext } from '../context'
import { schema } from '../db'
import { releaseReservation, settleReservation } from '../policy/authorize'
import { logActivity, wakeAgent } from '../services/activity'
import { agentSigner, getAgent } from '../services/agents'
import { FAILURE_CODES, FUNDER_DRAINED, sendAndWait, type FailureReason } from './trade'

export type RestingResult = 'skipped' | 'waiting' | 'filled' | 'failed'

/** Flash is asked at most this often about one resting order, unless it is time to expire it. */
const POLL_EVERY_MS = 8_000
/** A filled order whose bracket id never shows up is accepted anyway after this long. */
const BRACKET_ID_GRACE_MS = 120_000
const lastPoll = new Map<string, number>()

const usdcUnits = (decimal: string) => Number(parseUnits(decimal, USDC_DECIMALS))

export async function settleResting(ctx: AppContext, intentId: string): Promise<RestingResult> {
  const flash = ctx.flash
  const [intent] = await ctx.db
    .select()
    .from(schema.intents)
    .where(eq(schema.intents.intentId, intentId))
  if (!flash || !intent || intent.state !== 'RESTING' || !intent.flashOrderId) return 'skipped'
  const now = ctx.now()
  const due = intent.restingUntil != null && now >= intent.restingUntil
  if (!due && now - (lastPoll.get(intentId) ?? 0) < POLL_EVERY_MS) return 'waiting'
  lastPoll.set(intentId, now)

  const agent = await getAgent(ctx, intent.agentId)
  const funder = getAddress(agent.address)
  const signer = agentSigner(ctx, agent)
  let order: GetOrderResponse = await flash.api.getOrder(intent.flashOrderId, funder)

  // Past its time and still live (Flash expires it too, but never rely on that alone): cancel it.
  if (due && !TERMINAL_STATUSES.includes(order.order.status)) {
    await flash.api.cancelOrder(
      intent.flashOrderId,
      await signer.signMessage(cancelMessage(intent.flashOrderId)),
    )
    for (let i = 0; i < 20 && !TERMINAL_STATUSES.includes(order.order.status); i++) {
      await new Promise((r) => setTimeout(r, flash.pollMs))
      order = await flash.api.getOrder(intent.flashOrderId, funder)
    }
  }

  const fillTx = order.fills.find((f) => isHex(f.transactionId))?.transactionId
  const terminal = TERMINAL_STATUSES.includes(order.order.status)
  if (!terminal && !fillTx) return 'waiting'
  // Partly filled and still live: let it finish, or be cancelled at its expiry.
  if (!terminal && fillTx && order.order.status !== 'ORDER_STATUS_FILLED') return 'waiting'

  // A record may have landed on an earlier attempt whose receipt we never saw. Resending would
  // revert (the intent is already closed), so look for the transaction that did it instead.
  const send = async (fn: 'recordExecution' | 'recordFailure', args: readonly unknown[]) => {
    const tradeLog = ctx.contracts.tradeLog
    const [, , , status] = await ctx.publicClient.readContract({
      address: tradeLog,
      abi: tradeLogAbi,
      functionName: 'intents',
      args: [intent.intentHash as Hex],
    })
    if (status === (fn === 'recordExecution' ? 2 : 3)) {
      const latest = await ctx.publicClient.getBlockNumber()
      const [log] = await ctx.publicClient.getContractEvents({
        address: tradeLog,
        abi: tradeLogAbi,
        eventName: fn === 'recordExecution' ? 'IntentExecuted' : 'IntentFailed',
        args: { intentHash: intent.intentHash as Hex },
        fromBlock: latest > 5000n ? latest - 5000n : 0n,
      })
      return log?.transactionHash ?? null
    }
    return sendAndWait(
      ctx,
      signer,
      tradeLog,
      encodeFunctionData({ abi: tradeLogAbi, functionName: fn, args: args as never }),
      'internal_error',
    )
  }
  const [reservation] = await ctx.db
    .select()
    .from(schema.spendLedger)
    .where(and(eq(schema.spendLedger.ref, intentId), eq(schema.spendLedger.status, 'reserved')))
  const set = (fields: Partial<typeof schema.intents.$inferInsert>) =>
    ctx.db
      .update(schema.intents)
      .set({ ...fields, updatedAt: ctx.now() })
      .where(eq(schema.intents.intentId, intentId))

  if (fillTx) {
    const bracketId = order.order.attachedBracket?.bracketOrderId ?? null
    // The pair goes live with the fill; wait for its id so the exit can be tracked.
    // Counted from the fill, not from the order's expiry, so an early fill is not held up.
    const filledAt = Date.parse(order.fills[0]?.filledAt ?? '')
    const sinceFill = Number.isFinite(filledAt) ? now - filledAt : 0
    if (
      !bracketId &&
      order.order.status === 'ORDER_STATUS_FILLED' &&
      sinceFill < BRACKET_ID_GRACE_MS
    )
      return 'waiting'
    const spent = Math.min(
      usdcUnits(Number(order.order.filled?.contraAmount ?? '0').toFixed(6)),
      intent.sizeQuote,
    )
    try {
      const recordTx = await send('recordExecution', [intent.intentHash, fillTx as Hex])
      if (reservation) await settleReservation(ctx.db, reservation.id, spent)
      await set({
        state: 'EXECUTED',
        recordTx,
        flashBracketOrderId: bracketId,
        entryFillTx: fillTx,
        usdcSpent: spent,
        restingUntil: null,
      })
    } catch (err) {
      console.error(`[resting] ${intentId}: recording the fill failed; will retry:`, err)
      return 'waiting'
    }
    const price = order.fills[0]?.fillPrice
    await logActivity(
      ctx,
      agent.id,
      'flash',
      `Limit buy filled${price ? ` at ${Number(price).toFixed(2)}` : ''} (limit ${intent.limitPrice}). The trade is now open.`,
      { decisionId: intent.decisionId ?? undefined },
    )
    lastPoll.delete(intentId)
    return 'filled'
  }

  // Ended without buying anything.
  const reason: FailureReason =
    order.order.closeReason === FUNDER_DRAINED
      ? 'funds_drained'
      : due || order.order.closeReason === 'REASON_ORDER_EXPIRED'
        ? 'never_filled'
        : order.order.status === 'ORDER_STATUS_CANCELLED'
          ? 'order_cancelled'
          : 'order_rejected'
  try {
    const recordTx = await send('recordFailure', [intent.intentHash, FAILURE_CODES[reason]])
    if (reservation) await releaseReservation(ctx.db, reservation.id)
    await set({
      state: 'FAILED',
      failReason: `${reason}: ${order.order.closeReason ?? order.order.status}`.slice(0, 500),
      recordTx,
      restingUntil: null,
      ...(reason === 'funds_drained' ? { flashNote: FUNDS_DRAINED_NOTE } : {}),
    })
  } catch (err) {
    console.error(`[resting] ${intentId}: recording the failure failed; will retry:`, err)
    return 'waiting'
  }
  await logActivity(
    ctx,
    agent.id,
    'flash',
    reason === 'never_filled'
      ? `Limit buy at ${intent.limitPrice} expired unfilled. Nothing was bought and no market was opened.`
      : `Limit buy ended without filling (${reason.replaceAll('_', ' ')}). Nothing was bought.`,
    { decisionId: intent.decisionId ?? undefined },
  )
  await wakeAgent(ctx, agent.id)
  lastPoll.delete(intentId)
  return 'failed'
}
