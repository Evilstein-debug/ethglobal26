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
}

type StoredQuote = { req: QuoteRequest; res: QuoteResponse; price: number }
type StoredOrder = { order: FlashOrder; fills: FlashFill[]; legs?: { tp: number; sl: number } }

const ORDER_TYPES = {
  Order: [
    { name: 'funder', type: 'address' },
    { name: 'quoteId', type: 'string' },
    { name: 'qty', type: 'string' },
  ],
} as const

export class LocalFlashStub implements FlashApi {
  readonly kind = 'local-stub' as const
  priceUsd: number
  readonly #o: Required<LocalFlashStubOptions>
  readonly #quotes = new Map<string, StoredQuote>()
  readonly #orders = new Map<string, StoredOrder>()
  readonly #approved = new Set<string>()
  /** Every submit, in order, so tests can assert sequencing. */
  readonly submitted: { orderId: string; at: number }[] = []

  constructor(opts: LocalFlashStubOptions) {
    this.#o = { feeRate: 0.003, ...opts }
    this.priceUsd = opts.priceUsd
  }

  /** Move the market; resting brackets fire if a leg is crossed. */
  setPrice(priceUsd: number) {
    this.priceUsd = priceUsd
    for (const stored of this.#orders.values()) {
      const { order, legs } = stored
      if (!legs || order.status !== 'ORDER_STATUS_ACCEPTED') continue
      if (priceUsd >= legs.tp) this.#fill(stored, legs.tp)
      else if (priceUsd <= legs.sl) this.#fill(stored, legs.sl)
    }
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
        riskFlagged: false,
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

  #approveTx(funder: string, token: Address) {
    const key = `${funder.toLowerCase()}:${token.toLowerCase()}`
    if (this.#approved.has(key)) return null
    this.#approved.add(key)
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
    if (req.orderType !== 'market')
      throw new Error(`local stub: only market orders (got ${req.orderType})`)
    if (!req.funderAddress) throw new Error('local stub: funderAddress required')
    const qty = Number(req.qty)
    if (!(qty > 0)) throw new Error('local stub: qty must be > 0')
    const price = this.priceUsd
    const buy = req.side === 'buy'
    const grossOut = buy ? qty / price : qty * price
    const out = grossOut * (1 - this.#o.feeRate)
    const quoteId = `stub-q-${randomUUID()}`
    const spent = buy ? this.#o.usdc : this.#o.weth
    const received = buy ? this.#o.weth : this.#o.usdc
    const res: QuoteResponse = {
      quoteId,
      orderType: 'market',
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

    const orderId = randomUUID()
    const order = this.#newOrder(orderId, req, 'ORDER_STATUS_ACCEPTED')
    const entry: StoredOrder = { order, fills: [] }
    this.#orders.set(orderId, entry)
    this.submitted.push({ orderId, at: Date.now() })
    this.#fill(entry, this.priceUsd) // market orders fill at once

    let attachedBracket: SubmitOrderResponse['attachedBracket']
    if (stored.req.attachedBracket && req.attachedBracket) {
      const tp = Number(req.attachedBracket.takeProfit.notionalPrice)
      const sl = Number(req.attachedBracket.stopLoss.notionalPrice)
      const bracketId = randomUUID()
      const bracket = this.#newOrder(
        bracketId,
        { ...req, side: 'sell', qty: entry.order.filled!.targetAmount, orderType: 'bracket' },
        'ORDER_STATUS_ACCEPTED',
      )
      bracket.sourceEntryOrderId = orderId
      bracket.brackets = [
        { notionalPrice: String(tp), triggerType: 'upper' },
        { notionalPrice: String(sl), triggerType: 'lower' },
      ]
      this.#orders.set(bracketId, { order: bracket, fills: [], legs: { tp, sl } })
      order.attachedBracket = {
        status: 'active',
        bracketOrderId: bracketId,
        signedMaxFromAmount: req.attachedBracket.signedMaxFromAmount,
        expiresAt: null,
      }
      attachedBracket = { status: 'pending_activation' }
      this.setPrice(this.priceUsd) // a leg already crossed at activation fires immediately
    }
    return { orderId, attachedBracket }
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

  async getOrder(orderId: string, funderAddress: string): Promise<GetOrderResponse> {
    const stored = this.#orders.get(orderId)
    if (
      !stored ||
      !isAddressEqual(getAddress(stored.order.funderAddress), getAddress(funderAddress))
    ) {
      throw new Error('NOT_FOUND')
    }
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
    if (stored.order.status === 'ORDER_STATUS_ACCEPTED') {
      stored.order.status = 'ORDER_STATUS_CANCELLED'
      stored.order.closeReason = 'REASON_USER_REQUESTED'
      stored.order.closedAt = new Date().toISOString()
    }
  }
}
