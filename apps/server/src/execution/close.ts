/**
 * Close a position at the end of TRADING so PnL is realized:
 *   - the bracket already fired → that sale is the exit;
 *   - otherwise cancel the bracket (signed cancel message), then market-sell the WETH the entry
 *     bought (capped at the wallet balance on real chains).
 * Result: intents.usdc_received and state CLOSED. Realized PnL = usdc_received − usdc_spent.
 */
import { cancelMessage, type GetOrderResponse } from '@starter/flash'
import { eq } from 'drizzle-orm'
import { formatUnits, getAddress, isHex, parseUnits } from 'viem'
import { USDC_DECIMALS } from '@starter/shared/tokens'
import type { AppContext } from '../context'
import { schema } from '../db'
import { agentSigner, balancesOf, getAgent } from '../services/agents'
import { waitForTerminal } from './trade'

export type CloseResult =
  | {
      status: 'closed'
      intentId: string
      via: 'bracket' | 'market'
      usdcReceived: number
      exitFillTx: string
    }
  | { status: 'skipped'; intentId: string; reason: string }
  | { status: 'error'; intentId: string; detail: string }

const toUsdc = (decimal: string) =>
  Number(parseUnits(Number(decimal).toFixed(USDC_DECIMALS), USDC_DECIMALS))

async function finish(
  ctx: AppContext,
  intentId: string,
  via: 'bracket' | 'market',
  order: GetOrderResponse,
  closeOrderId?: string,
): Promise<CloseResult> {
  const exitFillTx = order.fills.find((f) => isHex(f.transactionId))?.transactionId ?? ''
  const usdcReceived = toUsdc(order.order.filled?.contraAmount ?? '0')
  await ctx.db
    .update(schema.intents)
    .set({
      state: 'CLOSED',
      usdcReceived,
      exitFillTx,
      flashCloseOrderId: closeOrderId ?? null,
      updatedAt: ctx.now(),
    })
    .where(eq(schema.intents.intentId, intentId))
  return { status: 'closed', intentId, via, usdcReceived, exitFillTx }
}

/** Read-only check: did a bracket leg fire? Returns the close, or null if still open. */
export async function syncExit(ctx: AppContext, intentId: string): Promise<CloseResult | null> {
  const flash = ctx.flash
  const [intent] = await ctx.db
    .select()
    .from(schema.intents)
    .where(eq(schema.intents.intentId, intentId))
  if (!flash || intent?.state !== 'EXECUTED' || !intent.flashBracketOrderId) return null
  const agent = await getAgent(ctx, intent.agentId)
  const bracket = await flash.api.getOrder(intent.flashBracketOrderId, getAddress(agent.address))
  return bracket.order.status === 'ORDER_STATUS_FILLED'
    ? finish(ctx, intentId, 'bracket', bracket)
    : null
}

export async function closePosition(ctx: AppContext, intentId: string): Promise<CloseResult> {
  const flash = ctx.flash
  const [intent] = await ctx.db
    .select()
    .from(schema.intents)
    .where(eq(schema.intents.intentId, intentId))
  if (!intent) return { status: 'skipped', intentId, reason: 'unknown_intent' }
  if (intent.state !== 'EXECUTED')
    return { status: 'skipped', intentId, reason: `state_${intent.state}` }
  if (!flash || !intent.flashOrderId)
    return { status: 'error', intentId, detail: 'flash_not_configured' }

  const agent = await getAgent(ctx, intent.agentId)
  const funder = getAddress(agent.address)
  const signer = agentSigner(ctx, agent)
  const done = (via: 'bracket' | 'market', order: GetOrderResponse, closeOrderId?: string) =>
    finish(ctx, intentId, via, order, closeOrderId)

  try {
    const entry = await flash.api.getOrder(intent.flashOrderId, funder)
    const bought = entry.order.filled?.targetAmount ?? '0'

    if (intent.flashBracketOrderId) {
      const bracket = await flash.api.getOrder(intent.flashBracketOrderId, funder)
      if (bracket.order.status === 'ORDER_STATUS_FILLED') return done('bracket', bracket)
      if (
        ['ORDER_STATUS_ACCEPTED', 'ORDER_STATUS_PENDING', 'ORDER_STATUS_PARTIALLY_FILLED'].includes(
          bracket.order.status,
        )
      ) {
        const signature = await signer.signMessage(cancelMessage(intent.flashBracketOrderId))
        await flash.api.cancelOrder(intent.flashBracketOrderId, signature)
        const after = await waitForTerminal(flash, intent.flashBracketOrderId, funder)
        // A leg may have fired between our read and the cancel.
        if (after.order.status === 'ORDER_STATUS_FILLED') return done('bracket', after)
      }
    }

    // Market-sell what the entry bought. On a real chain never sell more than the wallet holds.
    let qty = Number(bought)
    if (flash.api.kind === 'flash') {
      const { weth } = await balancesOf(ctx, funder)
      qty = Math.min(qty, Number(formatUnits(weth ?? 0n, 18)))
    }
    if (!(qty > 0)) return { status: 'skipped', intentId, reason: 'nothing_to_sell' }
    const sellQty = qty.toFixed(18).replace(/\.?0+$/, '')
    const common = {
      targetChain: flash.chain,
      contraChain: flash.chain,
      targetAsset: ctx.contracts.weth!,
      contraAsset: ctx.contracts.usdc,
      side: 'sell' as const,
      qty: sellQty,
      orderType: 'market' as const,
      evmUsePermit2: false,
      forceMinimalAllowance: true,
      flashIntegratorFeeBps: flash.integratorFeeBps,
    }
    const quote = await flash.api.quote({ ...common, funderAddress: funder })
    if (!quote.evm?.orderTypedData || quote.evm.permitTypedData)
      throw new Error('unexpected close quote shape')
    if (quote.evm.approveTx) {
      const hash = await signer.sendTransaction({
        to: getAddress(quote.evm.approveTx.to),
        data: quote.evm.approveTx.data as `0x${string}`,
      })
      const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`approve reverted ${hash}`)
    }
    const userSignature = await signer.signTypedData(JSON.parse(quote.evm.orderTypedData))
    const { orderId } = await flash.api.submitOrder({
      ...common,
      funderAddress: funder,
      quoteId: quote.quoteId,
      userSignature,
      evmOrderTypedData: quote.evm.orderTypedData,
      ...(flash.attributionCode ? { erc8021AttributionCode: flash.attributionCode } : {}),
    })
    await ctx.db
      .update(schema.intents)
      .set({ flashCloseOrderId: orderId, updatedAt: ctx.now() })
      .where(eq(schema.intents.intentId, intentId))
    const sold = await waitForTerminal(flash, orderId, funder)
    if (sold.order.status !== 'ORDER_STATUS_FILLED')
      throw new Error(`close order ${sold.order.status} ${sold.order.closeReason ?? ''}`)
    return done('market', sold, orderId)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    console.error(`[close] ${intentId}: ${detail}`)
    return { status: 'error', intentId, detail }
  }
}

/** Realized PnL of a closed intent in USDC base units (negative = loss). */
export function realizedPnl(intent: { usdcSpent: number | null; usdcReceived: number | null }) {
  if (intent.usdcSpent == null || intent.usdcReceived == null) return null
  return intent.usdcReceived - intent.usdcSpent
}
