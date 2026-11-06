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
  cancelMessage,
  TERMINAL_STATUSES,
  type FlashApi,
  type GetOrderResponse,
  type QuoteResponse,
  type QuoteStream,
} from '@starter/flash'
import { canonicalHash, canonicalJson, idHash } from '@starter/shared/canonical'
import { FUNDS_DRAINED_NOTE } from '@starter/shared/verify'
import { tradeLogAbi } from '@starter/shared/generated'
import { tradeIntentSchema, type TradeIntent } from '@starter/shared/schemas'
import { USDC_DECIMALS } from '@starter/shared/tokens'
import { and, eq, inArray, lte } from 'drizzle-orm'
import { encodeFunctionData, getAddress, isHex, parseUnits, type Hash, type Hex } from 'viem'
import type { AppContext, FlashSetup } from '../context'
import { riskGuard, wethInfo } from './weth'
import { schema } from '../db'
import {
  authorizeTrade,
  releaseReservation,
  settleReservation,
  type TradeDenyReason,
} from '../policy/authorize'
import { logActivity } from '../services/activity'
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
  /** Flash cancelled the order itself: the wallet no longer held what it needed. */
  funds_drained: 9,
  /** A resting limit entry expired (or was cancelled) without ever filling. */
  never_filled: 10,
} as const
export type FailureReason = keyof typeof FAILURE_CODES

export type TradeResult =
  | {
      status: 'denied'
      reason: TradeDenyReason | 'flash_not_configured' | 'asset_risk_flagged' | 'asset_check_failed'
    }
  | { status: 'failed'; intentId: string; reason: FailureReason; detail?: string; commitTx?: Hash }
  | {
      /** A limit entry is placed and waiting at Flash; execution/resting.ts finishes it. */
      status: 'resting'
      intentId: string
      intentHash: Hex
      commitTx: Hash
      flashOrderId: string
      limitPrice: string
      restingUntil: number
    }
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

/** Flash's own reason when it ends a resting order because the wallet can no longer fund it. */
export const FUNDER_DRAINED = 'REASON_INSUFFICIENT_FUNDER_BALANCE'

/** A TWAP is live once its first tranche has filled; the rest follow on Flash's schedule. */
export async function waitForFirstFill(flash: FlashSetup, orderId: string, funder: string) {
  const deadline = Date.now() + flash.fillTimeoutMs
  let last: GetOrderResponse | undefined
  while (Date.now() < deadline) {
    try {
      last = await flash.api.getOrder(orderId, funder)
      const filled = (last.order.completedFillCount ?? 0) > 0 || last.fills.length > 0
      // Its bracket activates at the first fill; wait for the pair's id like a market entry does.
      if (
        (filled && last.order.attachedBracket?.bracketOrderId) ||
        TERMINAL_STATUSES.includes(last.order.status)
      )
        return last
    } catch (err) {
      if (!/not.?found/i.test(String(err))) throw err
    }
    await sleep(flash.pollMs)
  }
  throw new TradeFailure(
    'fill_timeout',
    `TWAP ${orderId} had no fill after ${flash.fillTimeoutMs}ms`,
  )
}

/**
 * The risk guard. Code, not the model, refuses an asset Flash flags as risky before anything is
 * reserved, committed or signed. A failing lookup also refuses: no answer is not a yes. The one
 * exception (canonical Base WETH while Flash rations /search) is in riskGuard.
 */
async function assetGuard(flash: FlashSetup, wethAddress: string) {
  const info = await wethInfo(flash).catch(() => null)
  return riskGuard(info, flash, wethAddress)
}

export async function sendAndWait(
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
function checkQuote(q: QuoteResponse, qty: string, orderType: 'market' | 'twap' | 'limit') {
  if (q.side !== 'buy' || q.orderType !== orderType)
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
  const blocked = await assetGuard(flash, ctx.contracts.weth ?? '')
  if (blocked) return { status: 'denied', reason: blocked }

  const [agentRow] = await ctx.db
    .select()
    .from(schema.agents)
    .where(eq(schema.agents.address, intent.agentAddress.toLowerCase()))
  if (!agentRow) return { status: 'denied', reason: 'unknown_agent' }
  const agent = agentRow
  const twapPlan = intent.execution?.style === 'twap' ? intent.execution : undefined
  const limitPlan = intent.execution?.style === 'limit' ? intent.execution : undefined
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
    entryStyle: intent.execution?.style ?? 'market',
    twapBuckets: twapPlan?.buckets ?? null,
    twapDurationSec: twapPlan?.durationSeconds ?? null,
    limitPrice: limitPlan?.limitPrice ?? null,
    asset: intent.asset,
    sizeQuote: amount,
    entryRefPrice: intent.entryRefPrice,
    stopPrice: intent.stopPrice,
    targetPrice: intent.targetPrice,
    decisionId: opts.decisionId ?? null,
    createdAt: ctx.now(),
    updatedAt: ctx.now(),
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
  let stream: QuoteStream | undefined
  let submittedOrderId: string | undefined
  try {
    if (!weth) throw new TradeFailure('quote_failed', 'no WETH on this chain')
    const qty = intent.sizeQuote
    const bracket = {
      takeProfit: { notionalPrice: intent.targetPrice },
      stopLoss: { notionalPrice: intent.stopPrice },
    }
    const twap = twapPlan
    const limit = limitPlan
    const restingUntil = limit ? ctx.now() + limit.expireSeconds * 1000 : 0
    const common = {
      targetChain: flash.chain,
      contraChain: flash.chain,
      targetAsset: weth,
      contraAsset: usdc,
      side: 'buy' as const,
      qty,
      orderType: twap ? ('twap' as const) : limit ? ('limit' as const) : ('market' as const),
      // Quote and submit must carry the same tranche count; the duration is quote-time only.
      ...(twap ? { twapBucketCount: twap.buckets } : {}),
      // A limit buy fills at or below its price and is cancelled by Flash at its expiry.
      ...(limit
        ? {
            limitNotionalPrice: limit.limitPrice,
            expireTime: new Date(restingUntil).toISOString(),
          }
        : {}),
      evmUsePermit2: false,
      forceMinimalAllowance: true,
      flashIntegratorFeeBps: flash.integratorFeeBps,
    }
    const quoteRequest = {
      ...common,
      funderAddress: agentAddress,
      attachedBracket: bracket,
      ...(twap ? { durationSeconds: twap.durationSeconds } : {}),
    }
    const orderKind = common.orderType

    // ── 2. Quote ────────────────────────────────────────────────────────────────────────
    // A market entry listens to the Quotes WebSocket for a moment and signs the newest quote
    // (each revision replaces the last). Any trouble with the stream falls back to REST.
    let quote: QuoteResponse | undefined
    if (!twap && !limit && flash.quoteWindowMs && flash.api.openQuoteStream) {
      try {
        stream = await flash.api.openQuoteStream(quoteRequest)
        await sleep(flash.quoteWindowMs)
        const newest = stream.latest()
        checkQuote(newest, qty, orderKind)
        quote = newest
        await setIntent({
          quoteFirstOut: stream.first.to?.amount ?? null,
          quoteFinalOut: newest.to?.amount ?? null,
          quoteRevisions: stream.revisions(),
        })
      } catch (err) {
        console.warn(`[trade] ${intentId}: quote stream unusable, using REST:`, String(err))
        stream?.close()
        stream = undefined
      }
    }
    if (!quote) {
      try {
        quote = await flash.api.quote(quoteRequest)
      } catch (err) {
        throw new TradeFailure('quote_failed', err instanceof Error ? err.message : String(err))
      }
      checkQuote(quote, qty, orderKind)
    }

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
      submittedOrderId = orderId
    } catch (err) {
      throw new TradeFailure('submit_failed', err instanceof Error ? err.message : String(err))
    }
    if (limit) {
      // The order now rests at Flash and may fill any time before it expires. The market is not
      // opened and predictors see nothing until it does; resting.ts picks it up from here.
      await setIntent({
        state: 'RESTING',
        flashOrderId: orderId,
        restingUntil,
        limitPrice: limit.limitPrice,
      })
      await logActivity(
        ctx,
        agent.id,
        'flash',
        `Limit buy of ${intent.sizeQuote} USDC resting at ${limit.limitPrice} (market ${intent.entryRefPrice}), cancelled if unfilled in ${Math.round(limit.expireSeconds / 60)} min`,
        { decisionId: opts.decisionId ?? undefined },
      )
      return {
        status: 'resting',
        intentId,
        intentHash,
        commitTx,
        flashOrderId: orderId,
        limitPrice: limit.limitPrice,
        restingUntil,
      }
    }
    await setIntent({ state: 'EXECUTING', flashOrderId: orderId })

    // ── 6. Wait for the fill (and the pair's order id once it activates) ────────────────
    // A market order is done when it fills. A TWAP is live after its first tranche; the rest
    // follow on Flash's schedule and the crowd can trim them (execution/twap.ts).
    const final = twap
      ? await waitForFirstFill(flash, orderId, agentAddress)
      : await waitForTerminal(flash, orderId, agentAddress, (o) =>
          o.order.status !== 'ORDER_STATUS_FILLED'
            ? true
            : Boolean(o.order.attachedBracket?.bracketOrderId),
        )
    const fillTx = final.fills.find((f) => isHex(f.transactionId))?.transactionId
    const live = twap && fillTx && final.order.status !== 'ORDER_STATUS_REJECTED'
    if (final.order.status !== 'ORDER_STATUS_FILLED' && !live) {
      const reason: FailureReason =
        final.order.closeReason === FUNDER_DRAINED
          ? 'funds_drained'
          : final.order.status === 'ORDER_STATUS_CANCELLED'
            ? 'order_cancelled'
            : 'order_rejected'
      throw new TradeFailure(reason, final.order.closeReason ?? final.order.status)
    }
    if (!fillTx) throw new TradeFailure('order_rejected', 'filled order has no fill transaction')
    const spent = Math.min(usdcUnits(Number(final.order.filled!.contraAmount).toFixed(6)), amount)

    // ── 7. Record the execution onchain ─────────────────────────────────────────────────
    const recordTx = await record('recordExecution', [intentHash, fillTx as Hex])
    // A TWAP reserves its whole plan: the ledger must not free budget for tranches still to come.
    await settleReservation(ctx.db, auth.reservationId, twap ? amount : spent)
    const bracketOrderId = final.order.attachedBracket?.bracketOrderId ?? null
    await setIntent({
      state: 'EXECUTED',
      recordTx,
      flashBracketOrderId: bracketOrderId,
      entryFillTx: fillTx,
      usdcSpent: spent,
      twapNextCheckAt: twap
        ? ctx.now() + Math.round((twap.durationSeconds * 1000) / twap.buckets)
        : null,
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
    if (intent.execution && submittedOrderId) {
      // Never leave tranches (or a resting order) running for a trade we are about to record as failed.
      try {
        await flash.api.cancelOrder(
          submittedOrderId,
          await signer.signMessage(cancelMessage(submittedOrderId)),
        )
      } catch (cancelErr) {
        console.error(`[trade] ${intentId}: could not cancel TWAP ${submittedOrderId}:`, cancelErr)
      }
    }
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
      ...(failure.reason === 'funds_drained' ? { flashNote: FUNDS_DRAINED_NOTE } : {}),
    })
    return { status: 'failed', intentId, reason: failure.reason, detail: failure.detail, commitTx }
  } finally {
    stream?.close()
  }
}

const STUCK_AFTER_MS = 5 * 60_000

/**
 * After a crash an intent can be left mid-pipeline. Commits must still end onchain as executed or
 * failed, and a stuck intent would block the agent's next trade, so finish the job: a fill that
 * happened is recorded, everything else is recorded as a failure and its budget released.
 */
export async function recoverStuckIntents(ctx: AppContext) {
  const stuck = await ctx.db
    .select()
    .from(schema.intents)
    .where(
      and(
        inArray(schema.intents.state, ['DRAFT', 'COMMITTED', 'EXECUTING']),
        lte(schema.intents.updatedAt, ctx.now() - STUCK_AFTER_MS),
      ),
    )
  for (const intent of stuck) {
    const [agent] = await ctx.db
      .select()
      .from(schema.agents)
      .where(eq(schema.agents.id, intent.agentId))
    if (!agent) continue
    const [reservation] = await ctx.db
      .select()
      .from(schema.spendLedger)
      .where(
        and(eq(schema.spendLedger.ref, intent.intentId), eq(schema.spendLedger.status, 'reserved')),
      )
    const signer = agentSigner(ctx, agent)
    const send = (fn: 'recordExecution' | 'recordFailure', args: readonly unknown[]) =>
      sendAndWait(
        ctx,
        signer,
        ctx.contracts.tradeLog,
        encodeFunctionData({ abi: tradeLogAbi, functionName: fn, args: args as never }),
        'internal_error',
      )
    const set = (fields: Partial<typeof schema.intents.$inferInsert>) =>
      ctx.db
        .update(schema.intents)
        .set({ ...fields, updatedAt: ctx.now() })
        .where(eq(schema.intents.intentId, intent.intentId))
    try {
      if (intent.flashOrderId && ctx.flash) {
        const funder = getAddress(agent.address)
        const { order, fills } = await ctx.flash.api.getOrder(intent.flashOrderId, funder)
        const fillTx = fills.find((f) => isHex(f.transactionId))?.transactionId
        // A TWAP with a first fill is live: it counts as executed even though tranches remain.
        const liveTwap = intent.entryStyle === 'twap' && Boolean(fillTx)
        if (intent.entryStyle === 'limit' && !fillTx && !TERMINAL_STATUSES.includes(order.status)) {
          // Placed, then the server stopped before it was marked as resting: it is still waiting.
          const plan = (
            JSON.parse(intent.canonicalJson) as { execution?: { expireSeconds?: number } }
          ).execution
          await set({
            state: 'RESTING',
            restingUntil: intent.createdAt + (plan?.expireSeconds ?? 600) * 1000,
          })
          continue
        }
        if (!liveTwap && !TERMINAL_STATUSES.includes(order.status)) continue
        if ((order.status === 'ORDER_STATUS_FILLED' || liveTwap) && fillTx) {
          const spent = Math.min(
            usdcUnits(Number(order.filled!.contraAmount).toFixed(6)),
            intent.sizeQuote,
          )
          const recordTx = await send('recordExecution', [intent.intentHash, fillTx as Hex])
          if (reservation) await settleReservation(ctx.db, reservation.id, spent)
          await set({
            state: 'EXECUTED',
            recordTx,
            flashBracketOrderId: order.attachedBracket?.bracketOrderId ?? null,
            entryFillTx: fillTx,
            usdcSpent: spent,
          })
          continue
        }
      }
      const recordTx = intent.commitTx
        ? await send('recordFailure', [intent.intentHash, FAILURE_CODES.internal_error])
        : null
      if (reservation) await releaseReservation(ctx.db, reservation.id)
      await set({ state: 'FAILED', failReason: 'recovered_after_restart', recordTx })
    } catch (err) {
      console.error(`[trade] recovering ${intent.intentId} failed; will retry:`, err)
    }
  }
}

/** A fresh intent id, for callers building intents. */
export const newIntentId = () => randomUUID()
export type { FlashApi }
