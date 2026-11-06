/**
 * Definitive Flash API types: the subset AgentArena uses, transcribed from the official OpenAPI
 * spec (https://flash.definitive.fi/v1/openapi.json, info.version 2.0.0, read 2026-11-06).
 * Decimal amounts are strings, as in the API.
 */
export type FlashChain = 'base' | 'ethereum' | 'arbitrum' | 'optimism' | 'polygon' | (string & {})
export type OrderSide = 'buy' | 'sell'
export type OrderType =
  | 'market'
  | 'limit'
  | 'twap'
  | 'stop'
  | 'stop-loss'
  | 'take-profit'
  | 'bracket'
  | 'trailing-stop'
  | 'trailing-stop-limit'

export type OrderStatus =
  | 'ORDER_STATUS_UNSPECIFIED'
  | 'ORDER_STATUS_PENDING'
  | 'ORDER_STATUS_ACCEPTED'
  | 'ORDER_STATUS_PARTIALLY_FILLED'
  | 'ORDER_STATUS_FILLED'
  | 'ORDER_STATUS_CANCELLED'
  | 'ORDER_STATUS_REJECTED'
  | 'ORDER_STATUS_TERMINATED'

export const TERMINAL_STATUSES: readonly OrderStatus[] = [
  'ORDER_STATUS_FILLED',
  'ORDER_STATUS_CANCELLED',
  'ORDER_STATUS_REJECTED',
  'ORDER_STATUS_TERMINATED',
]

/** Each leg takes exactly one of notionalPrice (USD) or crossPrice, plus an optional limit. */
export type BracketLeg = { notionalPrice?: string; crossPrice?: string; limitPrice?: string }

export type QuoteRequest = {
  targetChain: FlashChain
  contraChain: FlashChain
  targetAsset: string
  contraAsset: string
  side: OrderSide
  /** Amount of the asset being SPENT: contraAsset units on a buy, targetAsset units on a sell. */
  qty: string
  orderType: OrderType
  funderAddress?: string
  maxSlippage?: string
  maxPriceImpact?: string
  evmUsePermit2?: boolean
  forceMinimalAllowance?: boolean
  /** Integer bps as a string; the same value must be sent on the order. */
  flashIntegratorFeeBps?: string
  expireTime?: string
  /** TWAP only. Total seconds (Flash minimum 300). Quote-time only: not echoed on submit. */
  durationSeconds?: number
  /** TWAP only. Number of tranches. Must match between quote and submit. */
  twapBucketCount?: number
  /** Limit only. USD price of the target asset: a buy fills at or below it. Same on submit. */
  limitNotionalPrice?: string
  /**
   * Limit only. Pair rate: contraAsset units per one targetAsset (USDC per WETH). Flash v1 requires
   * it instead of limitNotionalPrice when the limit entry carries an attachedBracket. Same on submit.
   */
  limitCrossPrice?: string
  attachedBracket?: { takeProfit: BracketLeg; stopLoss: BracketLeg; expireTime?: string }
}

export type EvmTx = { to: string; data: string }

export type QuoteResponse = {
  quoteId: string
  bridgeQuoteId?: string | null
  orderType: OrderType
  side: OrderSide
  targetAsset: string
  contraAsset: string
  from: { asset: string; amount: string; notional: string }
  to: { asset: string; amount: string; notional: string } | null
  fees: { estimatedFeeNotional: string }
  estimatedPriceImpact: string | null
  recommendedSlippage?: string | null
  wrap: unknown
  evm: {
    approveTx: EvmTx | null
    permitTypedData: string | null
    orderTypedData: string | null
  } | null
  svm: unknown
  attachedBracket?: {
    evm: { approveTx: EvmTx | null; permitTypedData: string | null; orderTypedData: string } | null
    svm: unknown
    salt: string | null
    deadline: string
    signedMaxFromAmount: string
  } | null
}

export type SubmitOrderRequest = Omit<
  QuoteRequest,
  'attachedBracket' | 'funderAddress' | 'durationSeconds'
> & {
  funderAddress: string
  quoteId?: string
  userSignature: string
  evmOrderTypedData?: string
  evmPermitTypedData?: string
  evmPermitSignature?: string
  erc8021AttributionCode?: string
  attachedBracket?: {
    takeProfit: BracketLeg
    stopLoss: BracketLeg
    userSignature: string
    salt?: string
    deadline: string
    signedMaxFromAmount: string
    evmPermitSignature?: string
    evmPermitTypedData?: string
  }
}

export type SubmitOrderResponse = { orderId: string; attachedBracket?: { status: string } }

export type FlashFill = {
  status: string
  notional: string
  venues: string[]
  filledAt: string
  orderId: string
  /** Onchain transaction hash of this fill. */
  transactionId: string
  fillPrice: string
  feeAmount: string
  feeTicker: string
  integratorFeeAmount: string
  feeNotional: string
  integratorFeeNotional: string
  contraAmount: string
  targetAmount: string
}

export type FlashOrder = {
  orderId: string
  orderType: OrderType
  side: OrderSide
  status: OrderStatus
  closeReason: string | null
  funderAddress: string
  qty: string
  filled: {
    targetAmount: string
    contraAmount: string
    averagePrice: string
    averageNotionalPrice: string
  } | null
  brackets:
    | { notionalPrice?: string; crossPrice?: string; triggerType: string; limitPrice?: string }[]
    | null
  attachedBracket?: {
    status: string
    bracketOrderId: string | null
    signedMaxFromAmount: string
    expiresAt: string | null
  } | null
  sourceEntryOrderId?: string | null
  /** TWAP progress: tranches planned and tranches filled so far. */
  twapBucketCount?: number | null
  completedFillCount?: number | null
  placedAt: string | null
  closedAt: string | null
}

export type GetOrderResponse = { order: FlashOrder; fills: FlashFill[] }

export type FlashAsset = {
  chain: FlashChain
  address: string
  symbol: string
  name: string
  decimals: number
  price: string
  liquidity: string
  riskFlagged: boolean
  /** Present on live /search responses (priceChange24h is a decimal: -0.0174 = -1.74%). */
  priceChange24h?: string
  volume24h?: string
  marketCap?: string
}

/**
 * A live quote session (Flash Quotes WebSocket). Every revision replaces the last and carries its
 * own quoteId; submitting one consumes the session, so keep it open until the order is sent.
 */
export type QuoteStream = {
  first: QuoteResponse
  latest(): QuoteResponse
  revisions(): number
  close(): void
}

/** The calls AgentArena makes. FlashClient talks to Flash; LocalFlashStub is for anvil tests. */
export interface FlashApi {
  readonly kind: 'flash' | 'local-stub'
  search(query: string, chain?: FlashChain, limit?: number): Promise<FlashAsset[]>
  quote(req: QuoteRequest): Promise<QuoteResponse>
  submitOrder(req: SubmitOrderRequest): Promise<SubmitOrderResponse>
  getOrder(orderId: string, funderAddress: string): Promise<GetOrderResponse>
  cancelOrder(orderId: string, userSignature: string): Promise<void>
  /** Optional: stream quote revisions for a market order. Callers fall back to `quote`. */
  openQuoteStream?(req: QuoteRequest): Promise<QuoteStream>
}
