/**
 * LOCAL TEST ONLY. An in-memory stand-in for the Flash API so the full trade pipeline runs on
 * anvil (Flash has no testnet). It is deliberately strict where the real API is strict:
 * signatures are recovered and must match the funder, cancels need the exact signed message,
 * brackets fire only when the price crosses a leg. Fill transaction hashes are FAKE (labeled
 * `kind: 'local-stub'`) and nothing moves onchain. Never wire this to a real chain.
 */
import { randomUUID } from 'node:crypto'
import {
  encodeFunctionData,
  erc20Abi,
  getAddress,
  isAddressEqual,
  keccak256,
  maxUint256,
  recoverMessageAddress,
  recoverTypedDataAddress,
  toBytes,
  type Address,
  type Hex,
} from 'viem'
import { cancelMessage } from './cancel'
import type {
  FlashApi,
  FlashAsset,
  FlashFill,
  FlashOrder,
  GetOrderResponse,
  OrderStatus,
  QuoteRequest,
  QuoteResponse,
  QuoteStream,
  SubmitOrderRequest,
  SubmitOrderResponse,
} from './types'

export type LocalFlashStubOptions = {
  chainId: number
  /** Stand-in "settlement" contract: the EIP-712 verifyingContract. */
  verifyingContract: Address
  /** Stand-in approval spender. */
  spender: Address
  /** The traded asset (WETH stand-in) and USDC addresses used in quotes. */
  weth: Address
  usdc: Address
  /** USD price of the traded asset. */
  priceUsd: number
  /** Total fee as a fraction of notional, taken from the output (default 0.3%). */
  feeRate?: number
  /** Clock for TWAP tranches (default Date.now); tests inject their own. */
  now?: () => number
  /** Flash's real TWAP minimum is 300 seconds; the stub mirrors it unless told otherwise. */
  minTwapSeconds?: number
  /** How often a quote stream re-quotes at the stub's current price. */
  streamEveryMs?: number
}

type StoredQuote = { req: QuoteRequest; res: QuoteResponse; price: number }
type StoredOrder = {
  order: FlashOrder
  fills: FlashFill[]
  legs?: { tp: number; sl: number }
  /** A resting limit buy: fills when the price is at or below it, or expires. */
  limit?: { price: number; expiresAt: number | null }
  /** The bracket waits for the entry's first fill, then goes live (Flash: "activation is at the first fill"). */
  plan?: { tp: number; sl: number; signedMaxFromAmount: string; funder: string }
  /** TWAP schedule: one tranche now, then one every `intervalMs`, each at the stub's price. */
  twap?: {
    startedAt: number
    intervalMs: number
    buckets: number
    bucketSpend: number
    bracketId?: string
  }
}

const ORDER_TYPES = {
  Order: [
    { name: 'funder', type: 'address' },
    { name: 'quoteId', type: 'string' },
    { name: 'qty', type: 'string' },
  ],
} as const

/** A limit's price in USDC per WETH: the pair rate, or the USD price (equal for a USDC pair). */
function limitOf(req: QuoteRequest) {
  return Number(req.limitCrossPrice ?? req.limitNotionalPrice)
}

export class LocalFlashStub implements FlashApi {
  readonly kind = 'local-stub' as const
  priceUsd: number
  /** Flip to see the risk-flag guard refuse the asset. */
  riskFlagged = false
  readonly #o: Required<LocalFlashStubOptions>
  readonly #quotes = new Map<string, StoredQuote>()
  readonly #orders = new Map<string, StoredOrder>()
  readonly #approved = new Set<string>()
  /** Every submit, in order, so tests can assert sequencing. */
  readonly submitted: { orderId: string; at: number }[] = []

  constructor(opts: LocalFlashStubOptions) {
    this.#o = {
      feeRate: 0.003,
      now: Date.now,
      minTwapSeconds: 300,
      streamEveryMs: 500,
      ...opts,
    }
    this.priceUsd = opts.priceUsd
  }

  /** Move the market; resting brackets fire if a leg is crossed. */
  setPrice(priceUsd: number) {
    this.priceUsd = priceUsd
    for (const stored of this.#orders.values()) this.#advance(stored)
    for (const stored of this.#orders.values()) this.#checkLegs(stored)
  }

  #checkLegs(stored: StoredOrder) {
    const { order, legs } = stored
    if (!legs || order.status !== 'ORDER_STATUS_ACCEPTED') return
    if (this.priceUsd >= legs.tp) this.#fill(stored, legs.tp)
    else if (this.priceUsd <= legs.sl) this.#fill(stored, legs.sl)
  }

  async search(query: string): Promise<FlashAsset[]> {
    if (!/weth|eth/i.test(query)) return []
    return [
      {
        chain: 'base',
        address: this.#o.weth,
        symbol: 'WETH',
        name: 'Wrapped Ether (local stub)',
        decimals: 18,
        price: this.priceUsd.toFixed(8),
        liquidity: '0',
        riskFlagged: this.riskFlagged,
      },
    ]
  }

  #typedData(funder: string, quoteId: string, qty: string, primary: 'Order') {
    return JSON.stringify({
      domain: {
        name: 'LocalFlashStub',
        version: '1',
        chainId: this.#o.chainId,
        verifyingContract: this.#o.verifyingContract,
      },
      types: ORDER_TYPES,
      primaryType: primary,
      message: { funder: getAddress(funder), quoteId, qty },
    })
  }

  /** Like Flash: an approval is offered until an order has been submitted against it. */
  #approveTx(funder: string, token: Address) {
    if (this.#approved.has(`${funder.toLowerCase()}:${token.toLowerCase()}`)) return null
    return {
      to: token,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: 'approve',
        args: [this.#o.spender, maxUint256],
      }),
    }
  }

  async quote(req: QuoteRequest): Promise<QuoteResponse> {
    if (req.orderType !== 'market' && req.orderType !== 'twap' && req.orderType !== 'limit')
      throw new Error(`local stub: only market, limit and twap orders (got ${req.orderType})`)
    // Mirrors Flash v1 (checked 2026-11-07 with read-only quotes): a zero integrator fee is a
    // validation error, and a limit entry with an attached bracket must use limitCrossPrice.
    if (req.flashIntegratorFeeBps !== undefined && !(Number(req.flashIntegratorFeeBps) > 0))
      throw new Error('local stub: flashIntegratorFeeBps must be a positive decimal')
    if (req.orderType === 'limit' && req.attachedBracket && req.limitNotionalPrice)
      throw new Error(
        'local stub: attached_bracket limit entries require limit_cross_price (limit_notional_price is not supported with the block)',
      )
    if (req.orderType === 'limit' && !(limitOf(req) > 0))
      throw new Error('local stub: a limit order needs limitCrossPrice or limitNotionalPrice')
    if (req.orderType === 'twap') {
      if (!((req.durationSeconds ?? 0) >= this.#o.minTwapSeconds))
        throw new Error(`local stub: TWAP duration must be at least ${this.#o.minTwapSeconds}s`)
      const buckets = req.twapBucketCount ?? 5
      if (!Number.isInteger(buckets) || buckets < 2)
        throw new Error('local stub: TWAP needs at least 2 tranches')
    }
    if (!req.funderAddress) throw new Error('local stub: funderAddress required')
    const qty = Number(req.qty)
    if (!(qty > 0)) throw new Error('local stub: qty must be > 0')
    // A limit buy is quoted at its limit when that is below the market.
    const price = req.orderType === 'limit' ? Math.min(this.priceUsd, limitOf(req)) : this.priceUsd
    const buy = req.side === 'buy'
    const grossOut = buy ? qty / price : qty * price
    const out = grossOut * (1 - this.#o.feeRate)
    const quoteId = `stub-q-${randomUUID()}`
    const spent = buy ? this.#o.usdc : this.#o.weth
    const received = buy ? this.#o.weth : this.#o.usdc
    const res: QuoteResponse = {
      quoteId,
      orderType: req.orderType,
      side: req.side,
      targetAsset: req.targetAsset,
      contraAsset: req.contraAsset,
      from: {
        asset: buy ? 'contra' : 'target',
        amount: req.qty,
        notional: (buy ? qty : qty * price).toFixed(6),
      },
      to: {
        asset: buy ? 'target' : 'contra',
        amount: out.toFixed(buy ? 18 : 6),
        notional: (buy ? out * price : out).toFixed(6),
      },
      fees: { estimatedFeeNotional: ((buy ? qty : qty * price) * this.#o.feeRate).toFixed(6) },
      estimatedPriceImpact: '0',
      wrap: null,
      evm: {
        approveTx: this.#approveTx(req.funderAddress, spent),
        permitTypedData: null,
        orderTypedData: this.#typedData(req.funderAddress, quoteId, req.qty, 'Order'),
      },
      svm: null,
      attachedBracket: req.attachedBracket
        ? {
            evm: {
              approveTx: this.#approveTx(req.funderAddress, received),
              permitTypedData: null,
              orderTypedData: this.#typedData(
                req.funderAddress,
                `${quoteId}:bracket`,
                (out * 1.05).toFixed(18),
                'Order',
              ),
            },
            svm: null,
            salt: keccak256(toBytes(quoteId)),
            deadline: '281474976710655',
            signedMaxFromAmount: (out * 1.05).toFixed(18),
          }
        : null,
    }
    this.#quotes.set(quoteId, { req, res, price })
    return res
  }

  async #checkSig(funder: string, typedJson: string | undefined | null, signature: string) {
    if (!typedJson) throw new Error('local stub: missing typed data')
    const typed = JSON.parse(typedJson)
    const signer = await recoverTypedDataAddress({ ...typed, signature: signature as Hex })
    if (!isAddressEqual(signer, getAddress(funder)))
      throw new Error('PERMISSION_DENIED: signature verification failed')
  }

  async submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResponse> {
    const stored = req.quoteId ? this.#quotes.get(req.quoteId) : undefined
    if (!stored) throw new Error('local stub: unknown quoteId')
    if (req.evmOrderTypedData !== stored.res.evm?.orderTypedData)
      throw new Error('local stub: typed data not echoed')
    if ((req.flashIntegratorFeeBps ?? '') !== (stored.req.flashIntegratorFeeBps ?? '')) {
      throw new Error('local stub: flashIntegratorFeeBps differs from quote')
    }
    await this.#checkSig(req.funderAddress, req.evmOrderTypedData, req.userSignature)
    if (stored.req.attachedBracket) {
      if (!req.attachedBracket) throw new Error('local stub: attachedBracket missing on submit')
      await this.#checkSig(
        req.funderAddress,
        stored.res.attachedBracket?.evm?.orderTypedData,
        req.attachedBracket.userSignature,
      )
    }

    // The approvals were sent before submitting; from now on quotes don't offer them again.
    this.#approved.add(`${req.funderAddress.toLowerCase()}:${this.#o.usdc.toLowerCase()}`)
    if (stored.req.attachedBracket)
      this.#approved.add(`${req.funderAddress.toLowerCase()}:${this.#o.weth.toLowerCase()}`)

    const orderId = randomUUID()
    const order = this.#newOrder(orderId, req, 'ORDER_STATUS_ACCEPTED')
    const entry: StoredOrder = { order, fills: [] }
    this.#orders.set(orderId, entry)
    this.submitted.push({ orderId, at: Date.now() })
    if (stored.req.orderType === 'twap') {
      const buckets = stored.req.twapBucketCount ?? 5
      entry.twap = {
        startedAt: this.#o.now(),
        intervalMs: ((stored.req.durationSeconds ?? 0) * 1000) / buckets,
        buckets,
        bucketSpend: Number(req.qty) / buckets,
      }
      order.twapBucketCount = buckets
      order.completedFillCount = 0
      this.#advance(entry) // the first tranche goes at once
    } else if (stored.req.orderType === 'limit') {
      entry.limit = {
        price: limitOf(stored.req),
        expiresAt: stored.req.expireTime ? Date.parse(stored.req.expireTime) : null,
      }
    } else {
      this.#fill(entry, this.priceUsd) // market orders fill at once
    }

    let attachedBracket: SubmitOrderResponse['attachedBracket']
    if (stored.req.attachedBracket && req.attachedBracket) {
      entry.plan = {
        tp: Number(req.attachedBracket.takeProfit.notionalPrice),
        sl: Number(req.attachedBracket.stopLoss.notionalPrice),
        signedMaxFromAmount: req.attachedBracket.signedMaxFromAmount,
        funder: req.funderAddress,
      }
      attachedBracket = { status: 'pending_activation' }
    }
    this.#advance(entry) // a limit already at or below its price fills now, then the bracket goes live
    return { orderId, attachedBracket }
  }

  /** The bracket pair goes live once its entry has filled something. */
  #activateBracket(entry: StoredOrder) {
    const { order, plan } = entry
    if (!plan || order.attachedBracket || !order.filled) return
    const bracketId = randomUUID()
    const bracket = this.#newOrder(
      bracketId,
      {
        side: 'sell',
        qty: order.filled.targetAmount,
        orderType: 'bracket',
        funderAddress: plan.funder,
      },
      'ORDER_STATUS_ACCEPTED',
    )
    bracket.sourceEntryOrderId = order.orderId
    bracket.brackets = [
      { notionalPrice: String(plan.tp), triggerType: 'upper' },
      { notionalPrice: String(plan.sl), triggerType: 'lower' },
    ]
    const stored: StoredOrder = { order: bracket, fills: [], legs: { tp: plan.tp, sl: plan.sl } }
    this.#orders.set(bracketId, stored)
    if (entry.twap) entry.twap.bracketId = bracketId
    order.attachedBracket = {
      status: 'active',
      bracketOrderId: bracketId,
      signedMaxFromAmount: plan.signedMaxFromAmount,
      expiresAt: null,
    }
    this.#checkLegs(stored) // a leg already crossed at activation fires immediately
  }

  #newOrder(
    orderId: string,
    req: {
      side: 'buy' | 'sell'
      qty: string
      orderType: FlashOrder['orderType']
      funderAddress: string
    },
    status: OrderStatus,
  ): FlashOrder {
    return {
      orderId,
      orderType: req.orderType,
      side: req.side,
      status,
      closeReason: null,
      funderAddress: req.funderAddress,
      qty: req.qty,
      filled: null,
      brackets: null,
      attachedBracket: null,
      placedAt: new Date().toISOString(),
      closedAt: null,
    }
  }

  /** Fill every TWAP tranche that is due by now, or stop the schedule if its bracket fired. */
  #advance(stored: StoredOrder) {
    const { order, twap, limit } = stored
    if (limit) {
      if (order.status !== 'ORDER_STATUS_ACCEPTED') return
      if (limit.expiresAt != null && this.#o.now() >= limit.expiresAt)
        this.#stop(stored, 'REASON_ORDER_EXPIRED')
      else if (this.priceUsd <= limit.price) {
        this.#fill(stored, this.priceUsd)
        this.#activateBracket(stored)
      }
      return
    }
    if (!twap) {
      this.#activateBracket(stored) // a market entry has filled: its pair goes live
      return
    }
    if (
      order.status !== 'ORDER_STATUS_ACCEPTED' &&
      order.status !== 'ORDER_STATUS_PARTIALLY_FILLED'
    )
      return
    const bracket = twap.bracketId ? this.#orders.get(twap.bracketId) : undefined
    if (bracket && bracket.order.status !== 'ORDER_STATUS_ACCEPTED') {
      this.#stop(stored, 'REASON_BRACKET_TRIGGERED')
      return
    }
    const due = Math.min(
      twap.buckets,
      Math.floor((this.#o.now() - twap.startedAt) / twap.intervalMs) + 1,
    )
    while ((order.completedFillCount ?? 0) < due) this.#fillBucket(stored, this.priceUsd)
    this.#activateBracket(stored)
  }

  #stop(stored: StoredOrder, reason: string) {
    stored.order.status = 'ORDER_STATUS_CANCELLED'
    stored.order.closeReason = reason
    stored.order.closedAt = new Date().toISOString()
  }

  #fillBucket(stored: StoredOrder, price: number) {
    const { order, twap } = stored
    const spend = twap!.bucketSpend
    const target = (spend / price) * (1 - this.#o.feeRate)
    const n = (order.completedFillCount ?? 0) + 1
    const totalTarget = Number(order.filled?.targetAmount ?? 0) + target
    const totalSpend = Number(order.filled?.contraAmount ?? 0) + spend
    order.completedFillCount = n
    order.filled = {
      targetAmount: totalTarget.toFixed(18),
      contraAmount: totalSpend.toFixed(6),
      averagePrice: ((totalSpend / totalTarget) * (1 - this.#o.feeRate)).toFixed(8),
      averageNotionalPrice: ((totalSpend / totalTarget) * (1 - this.#o.feeRate)).toFixed(8),
    }
    const filledAt = new Date().toISOString()
    if (n >= twap!.buckets) {
      order.status = 'ORDER_STATUS_FILLED'
      order.closedAt = filledAt
    } else order.status = 'ORDER_STATUS_PARTIALLY_FILLED'
    stored.fills.push({
      status: 'CONFIRMED',
      notional: spend.toFixed(6),
      venues: ['local-stub'],
      filledAt,
      orderId: order.orderId,
      transactionId: keccak256(toBytes(`local-stub-fill:${order.orderId}:${n}`)), // FAKE
      fillPrice: price.toFixed(8),
      feeAmount: '0',
      feeTicker: 'USDC',
      integratorFeeAmount: '0',
      feeNotional: (spend * this.#o.feeRate).toFixed(6),
      integratorFeeNotional: '0',
      contraAmount: spend.toFixed(6),
      targetAmount: target.toFixed(18),
    })
    const bracket = twap!.bracketId ? this.#orders.get(twap!.bracketId) : undefined
    if (bracket) bracket.order.qty = order.filled.targetAmount
  }

  /** TEST HELPER: end an order the way Flash does on its own (e.g. a depleted wallet). */
  forceCancel(orderId: string, reason: string) {
    const stored = this.#orders.get(orderId)
    if (!stored) throw new Error('NOT_FOUND')
    this.#stop(stored, reason)
  }

  /** Opens a quote session that re-quotes at the stub's current price. Revisions are real moves. */
  async openQuoteStream(req: QuoteRequest): Promise<QuoteStream> {
    const first = await this.quote(req)
    let latest = first
    let revisions = 1
    const timer = setInterval(() => {
      this.quote(req)
        .then((q) => {
          latest = q
          revisions++
        })
        .catch(() => undefined)
    }, this.#o.streamEveryMs)
    timer.unref?.()
    return {
      first,
      latest: () => latest,
      revisions: () => revisions,
      close: () => clearInterval(timer),
    }
  }

  #fill(stored: StoredOrder, price: number) {
    const { order } = stored
    const qty = Number(order.qty)
    const buy = order.side === 'buy'
    const target = buy ? (qty / price) * (1 - this.#o.feeRate) : qty
    const contra = buy ? qty : qty * price * (1 - this.#o.feeRate)
    order.status = 'ORDER_STATUS_FILLED'
    order.closedAt = new Date().toISOString()
    order.filled = {
      targetAmount: target.toFixed(18),
      contraAmount: contra.toFixed(6),
      averagePrice: price.toFixed(8),
      averageNotionalPrice: price.toFixed(8),
    }
    stored.fills.push({
      status: 'CONFIRMED',
      notional: (buy ? qty : qty * price).toFixed(6),
      venues: ['local-stub'],
      filledAt: order.closedAt,
      orderId: order.orderId,
      transactionId: keccak256(toBytes(`local-stub-fill:${order.orderId}`)), // FAKE: nothing onchain
      fillPrice: price.toFixed(8),
      feeAmount: '0',
      feeTicker: 'USDC',
      integratorFeeAmount: '0',
      feeNotional: ((buy ? qty : qty * price) * this.#o.feeRate).toFixed(6),
      integratorFeeNotional: '0',
      contraAmount: order.filled.contraAmount,
      targetAmount: order.filled.targetAmount,
    })
  }

  /**
   * The stub keeps orders in memory, but positions outlive a server restart. Put an open position
   * back, under its original order ids, so its bracket can still fire and it can still be closed.
   */
  restorePosition(p: {
    orderId: string
    bracketOrderId: string
    funderAddress: string
    usdcSpent: number
    entryPrice: number
    tp: number
    sl: number
  }) {
    const qty = (p.usdcSpent / p.entryPrice) * (1 - this.#o.feeRate)
    const req = { qty: String(p.usdcSpent), funderAddress: p.funderAddress }
    const order = this.#newOrder(
      p.orderId,
      { ...req, side: 'buy', orderType: 'market' },
      'ORDER_STATUS_FILLED',
    )
    order.filled = {
      targetAmount: qty.toFixed(18),
      contraAmount: p.usdcSpent.toFixed(6),
      averagePrice: p.entryPrice.toFixed(8),
      averageNotionalPrice: p.entryPrice.toFixed(8),
    }
    const bracket = this.#newOrder(
      p.bracketOrderId,
      { ...req, side: 'sell', qty: qty.toFixed(18), orderType: 'bracket' },
      'ORDER_STATUS_ACCEPTED',
    )
    this.#orders.set(p.orderId, { order, fills: [] })
    this.#orders.set(p.bracketOrderId, {
      order: bracket,
      fills: [],
      legs: { tp: p.tp, sl: p.sl },
    })
  }

  async getOrder(orderId: string, funderAddress: string): Promise<GetOrderResponse> {
    const stored = this.#orders.get(orderId)
    if (
      !stored ||
      !isAddressEqual(getAddress(stored.order.funderAddress), getAddress(funderAddress))
    ) {
      throw new Error('NOT_FOUND')
    }
    this.#advance(stored)
    return structuredClone({ order: stored.order, fills: stored.fills })
  }

  async cancelOrder(orderId: string, userSignature: string) {
    const stored = this.#orders.get(orderId)
    if (!stored) throw new Error('NOT_FOUND')
    const signer = await recoverMessageAddress({
      message: cancelMessage(orderId),
      signature: userSignature as Hex,
    })
    if (!isAddressEqual(signer, getAddress(stored.order.funderAddress)))
      throw new Error('PERMISSION_DENIED')
    this.#advance(stored)
    if (
      stored.order.status === 'ORDER_STATUS_ACCEPTED' ||
      stored.order.status === 'ORDER_STATUS_PARTIALLY_FILLED'
    ) {
      this.#stop(stored, 'REASON_USER_REQUESTED')
    }
  }
}
