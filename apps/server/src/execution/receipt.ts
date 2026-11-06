/**
 * Flash receipts: what Flash itself reports for each order of a trade, next to what we recorded.
 * Fills, prices, fees and trigger legs come straight from `GET /orders/{id}`; the PnL derived from
 * them is compared with the PnL we resolved from. A mismatch is shown, never hidden.
 * Reads only. Nothing here signs or moves anything.
 */
import type { GetOrderResponse } from '@starter/flash'
import { getAddress, parseUnits } from 'viem'
import { USDC_DECIMALS } from '@starter/shared/tokens'
import type { AppContext } from '../context'
import type { schema } from '../db'
import { getAgent } from '../services/agents'

type Intent = typeof schema.intents.$inferSelect

export type ReceiptOrder = {
  role: 'entry' | 'bracket' | 'close'
  orderId: string
  type: string
  status: string
  closeReason: string | null
  /** TWAP progress, when it is one. */
  tranches: { done: number; total: number } | null
  /** Take-profit / stop-loss legs as Flash holds them. */
  legs: { triggerType: string; priceUsd: string | null }[]
  fills: {
    at: string
    priceUsd: string
    tx: string
    usdc: string
    weth: string
    feeUsd: string
  }[]
  /** USDC moved by this order, per Flash's own totals. */
  usdc: string | null
}

export type Receipt =
  | { available: false; reason: string }
  | {
      available: true
      /** 'local-stub' means these numbers come from the labeled local stand-in, not Flash. */
      source: 'flash' | 'local-stub'
      orders: ReceiptOrder[]
      /** USDC base units. Null until the trade has closed. */
      flash: { spent: number; received: number; pnl: number } | null
      ours: { spent: number; received: number; pnl: number } | null
      /** Whether the two agree to within a base unit. Null while the trade is still open. */
      matches: boolean | null
    }

const toUnits = (decimal: string | undefined | null) =>
  decimal == null ? null : Number(parseUnits(Number(decimal).toFixed(USDC_DECIMALS), USDC_DECIMALS))

function describe(role: ReceiptOrder['role'], r: GetOrderResponse): ReceiptOrder {
  const { order, fills } = r
  return {
    role,
    orderId: order.orderId,
    type: order.orderType,
    status: order.status.replace('ORDER_STATUS_', '').toLowerCase(),
    closeReason: order.closeReason,
    tranches:
      order.twapBucketCount != null
        ? { done: order.completedFillCount ?? 0, total: order.twapBucketCount }
        : null,
    legs: (order.brackets ?? []).map((b) => ({
      triggerType: b.triggerType,
      priceUsd: b.notionalPrice ?? null,
    })),
    fills: fills.map((f) => ({
      at: f.filledAt,
      priceUsd: f.fillPrice,
      tx: f.transactionId,
      usdc: f.contraAmount,
      weth: f.targetAmount,
      feeUsd: f.feeNotional,
    })),
    usdc: order.filled?.contraAmount ?? null,
  }
}

export async function flashReceipt(ctx: AppContext, intent: Intent): Promise<Receipt> {
  const flash = ctx.flash
  if (!flash) return { available: false, reason: 'flash_not_configured' }
  if (!intent.flashOrderId) return { available: false, reason: 'no_order_placed' }
  try {
    const funder = getAddress((await getAgent(ctx, intent.agentId)).address)
    const get = (id: string) => flash.api.getOrder(id, funder)
    const entry = await get(intent.flashOrderId)
    const orders = [describe('entry', entry)]
    let exit: GetOrderResponse | undefined
    if (intent.flashBracketOrderId) {
      const bracket = await get(intent.flashBracketOrderId)
      orders.push(describe('bracket', bracket))
      if (bracket.order.status === 'ORDER_STATUS_FILLED') exit = bracket
    }
    if (intent.flashCloseOrderId) {
      const close = await get(intent.flashCloseOrderId)
      orders.push(describe('close', close))
      if (close.order.status === 'ORDER_STATUS_FILLED') exit = close
    }
    const spent = toUnits(entry.order.filled?.contraAmount)
    const received = toUnits(exit?.order.filled?.contraAmount)
    const closed = intent.state === 'CLOSED' && spent != null && received != null
    const flashPnl = closed ? { spent, received, pnl: received - spent } : null
    const ours =
      closed && intent.usdcSpent != null && intent.usdcReceived != null
        ? {
            spent: intent.usdcSpent,
            received: intent.usdcReceived,
            pnl: intent.usdcReceived - intent.usdcSpent,
          }
        : null
    return {
      available: true,
      source: flash.api.kind === 'flash' ? 'flash' : 'local-stub',
      orders,
      flash: flashPnl,
      ours,
      matches:
        flashPnl && ours
          ? Math.abs(flashPnl.pnl - ours.pnl) <= 1 && Math.abs(flashPnl.spent - ours.spent) <= 1
          : null,
    }
  } catch (err) {
    return {
      available: false,
      reason: err instanceof Error ? err.message.slice(0, 200) : 'flash_unreachable',
    }
  }
}
