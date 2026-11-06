/**
 * The trade pipeline. Order is enforced in code and covered by tests:
 *
 *   authorize (reserve budget) → TradeLog.commit (wait for receipt) → Flash quote (market buy +
 *   attached TP/SL bracket) → approvals → sign entry + pair → submit → poll → record outcome
 *
 * Nothing reaches Flash before the commit receipt is confirmed. Every commit ends onchain as
 * exactly one of recordExecution (with the entry fill tx) or recordFailure (with a reason code),
 * so a losing or failed trade can't be hidden.
 */
import { randomUUID } from 'node:crypto'
import {
  TERMINAL_STATUSES,
  type FlashApi,
  type GetOrderResponse,
  type QuoteResponse,
} from '@starter/flash'
import { canonicalHash, canonicalJson, idHash } from '@starter/shared/canonical'
import { tradeLogAbi } from '@starter/shared/generated'
import { tradeIntentSchema, type TradeIntent } from '@starter/shared/schemas'
import { USDC_DECIMALS } from '@starter/shared/tokens'
import { eq } from 'drizzle-orm'
import { encodeFunctionData, getAddress, isHex, parseUnits, type Hash, type Hex } from 'viem'
import type { AppContext, FlashSetup } from '../context'
import { schema } from '../db'
import {
  authorizeTrade,
  releaseReservation,
  settleReservation,
  type TradeDenyReason,
} from '../policy/authorize'
import { agentSigner, balancesOf } from '../services/agents'
import type { AgentSigner } from '../wallets/signer'

/** recordFailure reason codes (uint8), also shown in the UI. */
export const FAILURE_CODES = {
  quote_failed: 1,
  approve_failed: 2,
  sign_refused: 3,
  submit_failed: 4,
  order_rejected: 5,
  order_cancelled: 6,
  fill_timeout: 7,
  internal_error: 8,
} as const
export type FailureReason = keyof typeof FAILURE_CODES

export type TradeResult =
  | { status: 'denied'; reason: TradeDenyReason | 'flash_not_configured' }
  | { status: 'failed'; intentId: string; reason: FailureReason; detail?: string; commitTx?: Hash }
  | {
      status: 'executed'
      intentId: string
      intentHash: Hex
      commitTx: Hash
      recordTx: Hash
      flashOrderId: string
      bracketOrderId: string | null
      entryFillTx: string
      usdcSpent: number
    }

class TradeFailure extends Error {
  constructor(
    readonly reason: FailureReason,
    readonly detail?: string,
  ) {
    super(`${reason}${detail ? `: ${detail}` : ''}`)
  }
}

const usdcUnits = (decimal: string) => Number(parseUnits(decimal, USDC_DECIMALS))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitForTerminal(
  flash: FlashSetup,
  orderId: string,
  funder: string,
  extra?: (o: GetOrderResponse) => boolean,
) {
  const deadline = Date.now() + flash.fillTimeoutMs
  let last: GetOrderResponse | undefined
  while (Date.now() < deadline) {
    try {
      last = await flash.api.getOrder(orderId, funder)
      if (TERMINAL_STATUSES.includes(last.order.status) && (!extra || extra(last))) return last
    } catch (err) {
      // Reads can trail a placement by a second or two (Flash docs); keep polling.
      if (!/not.?found/i.test(String(err))) throw err
    }
    await sleep(flash.pollMs)
  }
  if (last && TERMINAL_STATUSES.includes(last.order.status)) return last
  throw new TradeFailure(
    'fill_timeout',
    `order ${orderId} not terminal after ${flash.fillTimeoutMs}ms`,
  )
}

async function sendAndWait(
  ctx: AppContext,
  signer: AgentSigner,
  to: string,
  data: string,
  reason: FailureReason,
) {
  if (!isHex(data)) throw new TradeFailure(reason, 'calldata is not hex')
  let hash: Hash
  try {
    hash = await signer.sendTransaction({ to: getAddress(to), data })
  } catch (err) {
    throw new TradeFailure(reason, err instanceof Error ? err.message : String(err))
  }
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new TradeFailure(reason, `tx reverted ${hash}`)
  return hash
}

async function signJson(signer: AgentSigner, typedJson: string) {
  try {
    return await signer.signTypedData(JSON.parse(typedJson))
  } catch (err) {
    throw new TradeFailure('sign_refused', err instanceof Error ? err.message : String(err))
  }
}

/** Basic sanity on the quote before anything is approved or signed. */
function checkQuote(q: QuoteResponse, qty: string) {
  if (q.side !== 'buy' || q.orderType !== 'market')
    throw new TradeFailure('quote_failed', 'unexpected quote shape')
  if (Number(q.from.amount) !== Number(qty))
    throw new TradeFailure('quote_failed', `quote spends ${q.from.amount}, asked ${qty}`)
  if (!q.evm?.orderTypedData) throw new TradeFailure('quote_failed', 'no orderTypedData')
  // We quote with evmUsePermit2: false; a Permit2 payload means the request wasn't honoured.
  if (q.evm.permitTypedData || q.attachedBracket?.evm?.permitTypedData)
    throw new TradeFailure('quote_failed', 'unexpected Permit2 payload')
  if (!q.attachedBracket?.evm?.orderTypedData)
    throw new TradeFailure('quote_failed', 'no bracket payload')
}

/**
 * Execute a validated intent for an agent. `entryId` links it to a round entry; `decisionId`
 * to the 0G decision that produced it (null for manual smoke-test trades).
 */
export async function executeTrade(
  ctx: AppContext,
  rawIntent: unknown,
  opts: { entryId?: number | null; decisionId?: string | null } = {},
): Promise<TradeResult> {
  const intent: TradeIntent = tradeIntentSchema.parse(rawIntent)
  const flash = ctx.flash
  if (!flash) return { status: 'denied', reason: 'flash_not_configured' }

  const [agentRow] = await ctx.db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.address, intent.agentAddress.toLowerCase()))
  if (!agentRow) return { status: 'denied', reason: 'unknown_agent' }
  const agent = agentRow
  const amount = usdcUnits(intent.sizeQuote)
  const { usdc: usdcBalance } = await balancesOf(ctx, getAddress(agent.address))

  const auth = await authorizeTrade(
    ctx.db,
    {
      agentId: agent.id,
      roundId: intent.roundId,
      amount,
      asset: intent.asset,
      ref: intent.intentId,
    },
    usdcBalance,
    ctx.now(),
    { cooldownMs: ctx.brain.tradeCooldownMs },
  )
  if (!auth.ok) return { status: 'denied', reason: auth.reason }

  const json = canonicalJson(intent)
  const intentHash = canonicalHash(intent)
  const intentId = intent.intentId
  await ctx.db.insert(schema.intents).values({
    intentId,
    roundId: intent.roundId,
    agentId: agent.id,
    entryId: opts.entryId ?? null,
    canonicalJson: json,
    intentHash,
    state: 'DRAFT',
    asset: intent.asset,
    sizeQuote: amount,
    entryRefPrice: intent.entryRefPrice,
    stopPrice: intent.stopPrice,
    targetPrice: intent.targetPrice,
    decisionId: opts.decisionId ?? null,
  })
  const setIntent = (fields: Partial<typeof schema.intents.$inferInsert>) =>
    ctx.db
      .update(schema.intents)
      .set({ ...fields, updatedAt: ctx.now() })
      .where(eq(schema.intents.intentId, intentId))

  const signer = agentSigner(ctx, agent)
  const tradeLog = ctx.contracts.tradeLog

  // ── 1. Commit onchain. Nothing below runs unless this receipt succeeds. ────────────────
  let commitTx: Hash
  try {
    commitTx = await sendAndWait(
      ctx,
      signer,
      tradeLog,
      encodeFunctionData({
        abi: tradeLogAbi,
        functionName: 'commit',
        args: [BigInt(intent.roundId), intentHash, idHash(intent.zeroG.requestId)],
      }),
      'internal_error',
    )
  } catch (err) {
    await releaseReservation(ctx.db, auth.reservationId)
    const detail = err instanceof Error ? err.message : String(err)
    await setIntent({ state: 'FAILED', failReason: `commit_failed: ${detail}`.slice(0, 500) })
    return {
      status: 'failed',
      intentId,
      reason: 'internal_error',
      detail: `commit failed: ${detail}`,
    }
  }
  await setIntent({ state: 'COMMITTED', commitTx })

  const record = async (fn: 'recordExecution' | 'recordFailure', args: readonly unknown[]) =>
    sendAndWait(
      ctx,
      signer,
      tradeLog,
      encodeFunctionData({ abi: tradeLogAbi, functionName: fn, args: args as never }),
      'internal_error',
    )

  const agentAddress = getAddress(agent.address)
  const usdc = ctx.contracts.usdc
  const weth = ctx.contracts.weth
  try {
    if (!weth) throw new TradeFailure('quote_failed', 'no WETH on this chain')
    const qty = intent.sizeQuote
    const bracket = {
      takeProfit: { notionalPrice: intent.targetPrice },
      stopLoss: { notionalPrice: intent.stopPrice },
    }
    const common = {
      targetChain: flash.chain,
      contraChain: flash.chain,
      targetAsset: weth,
      contraAsset: usdc,
      side: 'buy' as const,
      qty,
      orderType: 'market' as const,
      evmUsePermit2: false,
      forceMinimalAllowance: true,
      flashIntegratorFeeBps: flash.integratorFeeBps,
    }

    // ── 2. Quote ────────────────────────────────────────────────────────────────────────
    let quote: QuoteResponse
    try {
      quote = await flash.api.quote({
        ...common,
        funderAddress: agentAddress,
        attachedBracket: bracket,
      })
    } catch (err) {
      throw new TradeFailure('quote_failed', err instanceof Error ? err.message : String(err))
    }
    checkQuote(quote, qty)

    // ── 3. Approvals (USDC for the entry, WETH for the bracket exit) ────────────────────
    for (const tx of [quote.evm!.approveTx, quote.attachedBracket!.evm!.approveTx]) {
      if (tx) await sendAndWait(ctx, signer, tx.to, tx.data, 'approve_failed')
    }

    // ── 4. Sign entry and pair ───────────────────────────────────────────────────────────
    const entrySig = await signJson(signer, quote.evm!.orderTypedData!)
    const pairSig = await signJson(signer, quote.attachedBracket!.evm!.orderTypedData)

    // ── 5. Submit ────────────────────────────────────────────────────────────────────────
    let orderId: string
    try {
      const submitted = await flash.api.submitOrder({
        ...common,
        funderAddress: agentAddress,
        quoteId: quote.quoteId,
        userSignature: entrySig,
        evmOrderTypedData: quote.evm!.orderTypedData!,
        ...(flash.attributionCode ? { erc8021AttributionCode: flash.attributionCode } : {}),
        attachedBracket: {
          ...bracket,
          userSignature: pairSig,
          ...(quote.attachedBracket!.salt ? { salt: quote.attachedBracket!.salt } : {}),
          deadline: quote.attachedBracket!.deadline,
          signedMaxFromAmount: quote.attachedBracket!.signedMaxFromAmount,
        },
      })
      orderId = submitted.orderId
    } catch (err) {
      throw new TradeFailure('submit_failed', err instanceof Error ? err.message : String(err))
    }
    await setIntent({ state: 'EXECUTING', flashOrderId: orderId })

    // ── 6. Wait for the fill (and the pair's order id once it activates) ────────────────
    const final = await waitForTerminal(flash, orderId, agentAddress, (o) =>
      o.order.status !== 'ORDER_STATUS_FILLED'
        ? true
        : Boolean(o.order.attachedBracket?.bracketOrderId),
    )
    if (final.order.status !== 'ORDER_STATUS_FILLED') {
      const reason: FailureReason =
        final.order.status === 'ORDER_STATUS_CANCELLED' ? 'order_cancelled' : 'order_rejected'
      throw new TradeFailure(reason, final.order.closeReason ?? final.order.status)
    }
    const fillTx = final.fills.find((f) => isHex(f.transactionId))?.transactionId
    if (!fillTx) throw new TradeFailure('order_rejected', 'filled order has no fill transaction')
    const spent = Math.min(usdcUnits(Number(final.order.filled!.contraAmount).toFixed(6)), amount)

    // ── 7. Record the execution onchain ─────────────────────────────────────────────────
    const recordTx = await record('recordExecution', [intentHash, fillTx as Hex])
    await settleReservation(ctx.db, auth.reservationId, spent)
    const bracketOrderId = final.order.attachedBracket?.bracketOrderId ?? null
    await setIntent({
      state: 'EXECUTED',
      recordTx,
      flashBracketOrderId: bracketOrderId,
      entryFillTx: fillTx,
      usdcSpent: spent,
    })
    return {
      status: 'executed',
      intentId,
      intentHash,
      commitTx,
      recordTx,
      flashOrderId: orderId,
      bracketOrderId,
      entryFillTx: fillTx,
      usdcSpent: spent,
    }
  } catch (err) {
    const failure =
      err instanceof TradeFailure
        ? err
        : new TradeFailure('internal_error', err instanceof Error ? err.message : String(err))
    console.warn(`[trade] ${intentId} failed: ${failure.message}`)
    await releaseReservation(ctx.db, auth.reservationId).catch(() => undefined)
    let recordTx: Hash | undefined
    try {
      recordTx = await record('recordFailure', [intentHash, FAILURE_CODES[failure.reason]])
    } catch (recordErr) {
      console.error(`[trade] ${intentId}: recordFailure failed (will need a retry):`, recordErr)
    }
    await setIntent({
      state: 'FAILED',
      failReason: failure.message.slice(0, 500),
      recordTx: recordTx ?? null,
    })
    return { status: 'failed', intentId, reason: failure.reason, detail: failure.detail, commitTx }
  }
}

/** A fresh intent id, for callers building intents. */
export const newIntentId = () => randomUUID()
export type { FlashApi }
