import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { cancelMessage, isCancelMessage } from './cancel'
import { FlashApiError, FlashClient } from './client'
import { LocalFlashStub } from './stub'

const ORDER_ID = '6bdb29aa-1b2c-4d3e-8f90-123456789abc'

test('stub, like Flash: a zero integrator fee and a USD-priced bracketed limit are rejected', async () => {
  const stub = new LocalFlashStub(stubOpts)
  const { limitCrossPrice: _c, ...usdPriced } = limitRequest('2950')
  await assert.rejects(
    stub.quote({ ...usdPriced, limitNotionalPrice: '2950' }),
    /limit_cross_price/,
  )
  await assert.rejects(
    stub.quote({ ...limitRequest('2950'), flashIntegratorFeeBps: '0' }),
    /positive decimal/,
  )
  assert.ok((await stub.quote(limitRequest('2950'))).quoteId)
})

test('cancel message matches the documented bytes', () => {
  const msg = cancelMessage(ORDER_ID)
  assert.equal(msg, `Definitive Flash v1 — Cancel Order\nOrder: ${ORDER_ID}`)
  assert.equal(msg.charCodeAt('Definitive Flash v1 '.length), 0x2014, 'em dash, not hyphen')
  assert.ok(isCancelMessage(msg))
  assert.ok(!isCancelMessage(msg.replace('—', '-')))
  assert.ok(!isCancelMessage(`${msg}\nTransfer everything`))
  assert.ok(!isCancelMessage('hello'))
  assert.throws(() => cancelMessage('not-a-uuid'), /not an order UUID/)
})

function fakeFetch(
  responses: { status: number; body?: unknown; headers?: Record<string, string> }[],
) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const r = responses.shift()
    if (!r) throw new Error('no more responses')
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), {
      status: r.status,
      headers: r.headers,
    })
  }) as unknown as typeof fetch
  return { fn, calls }
}

test('client sends the API key and JSON body', async () => {
  const { fn, calls } = fakeFetch([{ status: 200, body: { quoteId: 'q1' } }])
  const client = new FlashClient({ apiKey: 'dpka_test', fetch: fn })
  const res = await client.quote({
    targetChain: 'base',
    contraChain: 'base',
    targetAsset: '0x1',
    contraAsset: '0x2',
    side: 'buy',
    qty: '5',
    orderType: 'market',
  })
  assert.equal(res.quoteId, 'q1')
  assert.equal(calls[0]!.url, 'https://flash.definitive.fi/v1/quote')
  assert.equal(
    (calls[0]!.init.headers as Record<string, string>)['x-definitive-api-key'],
    'dpka_test',
  )
  assert.equal(JSON.parse(calls[0]!.init.body as string).qty, '5')
})

test('client builds query strings for search and getOrder', async () => {
  const { fn, calls } = fakeFetch([
    { status: 200, body: { assets: [] } },
    { status: 200, body: { order: {}, fills: [] } },
  ])
  const client = new FlashClient({ apiKey: 'k', fetch: fn })
  await client.search('weth', 'base', 1)
  await client.getOrder(ORDER_ID, '0xabc')
  assert.equal(calls[0]!.url, 'https://flash.definitive.fi/v1/search?query=weth&limit=1&chain=base')
  assert.equal(
    calls[1]!.url,
    `https://flash.definitive.fi/v1/orders/${ORDER_ID}?funderAddress=0xabc`,
  )
})

test('client cancel posts the exact message and signature', async () => {
  const { fn, calls } = fakeFetch([{ status: 200, body: { ok: true } }])
  await new FlashClient({ apiKey: 'k', fetch: fn }).cancelOrder(ORDER_ID, '0xsig')
  assert.deepEqual(JSON.parse(calls[0]!.init.body as string), {
    cancelMessage: cancelMessage(ORDER_ID),
    userSignature: '0xsig',
  })
})

test('client surfaces API errors and retries 429/5xx', async () => {
  const { fn, calls } = fakeFetch([
    { status: 429, headers: { 'retry-after': '0' } },
    { status: 503 },
    { status: 400, body: { error: { code: 'VALIDATION_ERROR', message: 'qty too small' } } },
  ])
  const client = new FlashClient({ apiKey: 'k', fetch: fn, backoffMs: 1 })
  await assert.rejects(
    client.quote({} as never),
    (e: unknown) =>
      e instanceof FlashApiError &&
      e.status === 400 &&
      e.code === 'VALIDATION_ERROR' &&
      /qty too small/.test(e.message),
  )
  assert.equal(calls.length, 3)
  assert.throws(() => new FlashClient({ apiKey: '' }), /apiKey/)
})

// ── LocalFlashStub ──────────────────────────────────────────────────────────────────────

const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const funder = privateKeyToAccount(`0x${'07'.repeat(32)}`)
const intruder = privateKeyToAccount(`0x${'08'.repeat(32)}`)
const stubOpts = {
  chainId: 31337,
  verifyingContract: a(0xf1),
  spender: a(0xf2),
  weth: a(0xe1),
  usdc: a(0xe2),
  priceUsd: 3000,
}

async function buyWithBracket(stub: LocalFlashStub, signer = funder) {
  const q = await stub.quote({
    targetChain: 'base',
    contraChain: 'base',
    targetAsset: stubOpts.weth,
    contraAsset: stubOpts.usdc,
    side: 'buy',
    qty: '5',
    orderType: 'market',
    funderAddress: funder.address,
    attachedBracket: { takeProfit: { notionalPrice: '3060' }, stopLoss: { notionalPrice: '2950' } },
  })
  const sign = (json: string) => signer.signTypedData(JSON.parse(json))
  return stub.submitOrder({
    targetChain: 'base',
    contraChain: 'base',
    targetAsset: stubOpts.weth,
    contraAsset: stubOpts.usdc,
    side: 'buy',
    qty: '5',
    orderType: 'market',
    funderAddress: funder.address,
    quoteId: q.quoteId,
    userSignature: await sign(q.evm!.orderTypedData!),
    evmOrderTypedData: q.evm!.orderTypedData!,
    attachedBracket: {
      takeProfit: { notionalPrice: '3060' },
      stopLoss: { notionalPrice: '2950' },
      userSignature: await sign(q.attachedBracket!.evm!.orderTypedData),
      salt: q.attachedBracket!.salt!,
      deadline: q.attachedBracket!.deadline,
      signedMaxFromAmount: q.attachedBracket!.signedMaxFromAmount,
    },
  })
}

test('stub: market buy fills; bracket takes profit when price crosses TP', async () => {
  const stub = new LocalFlashStub(stubOpts)
  const { orderId } = await buyWithBracket(stub)
  const entry = await stub.getOrder(orderId, funder.address)
  assert.equal(entry.order.status, 'ORDER_STATUS_FILLED')
  assert.equal(entry.fills.length, 1)
  const bracketId = entry.order.attachedBracket!.bracketOrderId!
  assert.equal(
    (await stub.getOrder(bracketId, funder.address)).order.status,
    'ORDER_STATUS_ACCEPTED',
  )
  stub.setPrice(3059)
  assert.equal(
    (await stub.getOrder(bracketId, funder.address)).order.status,
    'ORDER_STATUS_ACCEPTED',
  )
  stub.setPrice(3061)
  const exit = await stub.getOrder(bracketId, funder.address)
  assert.equal(exit.order.status, 'ORDER_STATUS_FILLED')
  assert.equal(exit.fills[0]!.fillPrice, '3060.00000000')
  // 5 USDC → WETH at 3000, sold at 3060, 0.3% fee each way ≈ +1.39% net
  const pnl = Number(exit.order.filled!.contraAmount) - 5
  assert.ok(pnl > 0.06 && pnl < 0.08, `pnl ${pnl}`)
})

test('stub: stop-loss fires below SL', async () => {
  const stub = new LocalFlashStub(stubOpts)
  const { orderId } = await buyWithBracket(stub)
  const bracketId = (await stub.getOrder(orderId, funder.address)).order.attachedBracket!
    .bracketOrderId!
  stub.setPrice(2900)
  const exit = await stub.getOrder(bracketId, funder.address)
  assert.equal(exit.order.status, 'ORDER_STATUS_FILLED')
  assert.ok(Number(exit.order.filled!.contraAmount) < 5)
})

test('stub: rejects signatures from anyone but the funder', async () => {
  const stub = new LocalFlashStub(stubOpts)
  await assert.rejects(buyWithBracket(stub, intruder), /signature verification failed/)
})

test('stub: cancel needs the funder signature over the exact message', async () => {
  const stub = new LocalFlashStub(stubOpts)
  const { orderId } = await buyWithBracket(stub)
  const bracketId = (await stub.getOrder(orderId, funder.address)).order.attachedBracket!
    .bracketOrderId!
  await assert.rejects(
    stub.cancelOrder(bracketId, await intruder.signMessage({ message: cancelMessage(bracketId) })),
    /PERMISSION_DENIED/,
  )
  await stub.cancelOrder(bracketId, await funder.signMessage({ message: cancelMessage(bracketId) }))
  const order = (await stub.getOrder(bracketId, funder.address)).order
  assert.equal(order.status, 'ORDER_STATUS_CANCELLED')
  stub.setPrice(5000) // a cancelled bracket never fires
  assert.equal(
    (await stub.getOrder(bracketId, funder.address)).order.status,
    'ORDER_STATUS_CANCELLED',
  )
})

test('stub: an approval is offered until an order has been submitted against it', async () => {
  const stub = new LocalFlashStub(stubOpts)
  const req = {
    targetChain: 'base',
    contraChain: 'base',
    targetAsset: stubOpts.weth,
    contraAsset: stubOpts.usdc,
    side: 'buy',
    qty: '1',
    orderType: 'market',
    funderAddress: funder.address,
  } as const
  assert.ok((await stub.quote(req)).evm!.approveTx)
  assert.ok((await stub.quote(req)).evm!.approveTx, 'still offered: nothing submitted yet')
  await buyWithBracket(stub)
  assert.equal((await stub.quote(req)).evm!.approveTx, null)
})

function twapRequest(buckets = 4, durationSeconds = 400) {
  return {
    targetChain: 'base',
    contraChain: 'base',
    targetAsset: stubOpts.weth,
    contraAsset: stubOpts.usdc,
    side: 'buy',
    qty: '8',
    orderType: 'twap',
    durationSeconds,
    twapBucketCount: buckets,
    funderAddress: funder.address,
    attachedBracket: { takeProfit: { notionalPrice: '3060' }, stopLoss: { notionalPrice: '2950' } },
  } as const
}

async function submitTwap(stub: LocalFlashStub, buckets = 4) {
  const { durationSeconds: _d, attachedBracket: _b, ...base } = twapRequest(buckets)
  const q = await stub.quote(twapRequest(buckets))
  const sign = (json: string) => funder.signTypedData(JSON.parse(json))
  return stub.submitOrder({
    ...base,
    quoteId: q.quoteId,
    userSignature: await sign(q.evm!.orderTypedData!),
    evmOrderTypedData: q.evm!.orderTypedData!,
    attachedBracket: {
      takeProfit: { notionalPrice: '3060' },
      stopLoss: { notionalPrice: '2950' },
      userSignature: await sign(q.attachedBracket!.evm!.orderTypedData),
      salt: q.attachedBracket!.salt!,
      deadline: q.attachedBracket!.deadline,
      signedMaxFromAmount: q.attachedBracket!.signedMaxFromAmount,
    },
  })
}

test('stub: a TWAP fills one tranche at once, then one per interval, with its bracket growing', async () => {
  let now = 1_000_000
  const stub = new LocalFlashStub({ ...stubOpts, now: () => now })
  const { orderId } = await submitTwap(stub)
  const first = await stub.getOrder(orderId, funder.address)
  assert.equal(first.order.status, 'ORDER_STATUS_PARTIALLY_FILLED')
  assert.equal(first.order.completedFillCount, 1)
  assert.equal(first.order.twapBucketCount, 4)
  assert.equal(first.fills.length, 1)
  const bracketId = first.order.attachedBracket!.bracketOrderId!
  const qty1 = Number((await stub.getOrder(bracketId, funder.address)).order.qty)

  now += 100_000 // one interval (400s / 4)
  const second = await stub.getOrder(orderId, funder.address)
  assert.equal(second.order.completedFillCount, 2)
  assert.ok(Number((await stub.getOrder(bracketId, funder.address)).order.qty) > qty1)

  now += 1_000_000 // far past the end: everything fills, nothing more
  const done = await stub.getOrder(orderId, funder.address)
  assert.equal(done.order.status, 'ORDER_STATUS_FILLED')
  assert.equal(done.order.completedFillCount, 4)
  assert.equal(done.fills.length, 4)
  assert.ok(Math.abs(Number(done.order.filled!.contraAmount) - 8) < 0.001)
})

test('stub: cancelling a TWAP keeps what filled and stops the rest', async () => {
  let now = 0
  const stub = new LocalFlashStub({ ...stubOpts, now: () => now })
  const { orderId } = await submitTwap(stub)
  now += 100_000
  await stub.cancelOrder(orderId, await funder.signMessage({ message: cancelMessage(orderId) }))
  now += 1_000_000
  const o = await stub.getOrder(orderId, funder.address)
  assert.equal(o.order.status, 'ORDER_STATUS_CANCELLED')
  assert.equal(o.order.completedFillCount, 2)
  assert.equal(o.fills.length, 2)
})

test('stub: a fired bracket stops the remaining tranches', async () => {
  let now = 0
  const stub = new LocalFlashStub({ ...stubOpts, now: () => now })
  const { orderId } = await submitTwap(stub)
  stub.setPrice(3100) // take-profit crossed
  now += 1_000_000
  const o = await stub.getOrder(orderId, funder.address)
  assert.equal(o.order.status, 'ORDER_STATUS_CANCELLED')
  assert.equal(o.order.completedFillCount, 1)
})

test('stub: TWAPs shorter than the Flash minimum are refused', async () => {
  const stub = new LocalFlashStub(stubOpts)
  await assert.rejects(stub.quote(twapRequest(4, 120)), /at least 300s/)
})

test('stub: a quote stream follows the market and keeps every revision signable', async () => {
  const stub = new LocalFlashStub({ ...stubOpts, streamEveryMs: 10 })
  const stream = await stub.openQuoteStream!({
    ...twapRequest(),
    orderType: 'market',
  })
  stub.setPrice(2900)
  await new Promise((r) => setTimeout(r, 80))
  assert.ok(stream.revisions() > 1)
  assert.notEqual(stream.latest().quoteId, stream.first.quoteId)
  assert.ok(
    Number(stream.latest().to!.amount) > Number(stream.first.to!.amount),
    'cheaper → more WETH',
  )
  stream.close()
})

test('stub: risk-flagged assets are reported by search', async () => {
  const stub = new LocalFlashStub(stubOpts)
  assert.equal((await stub.search('WETH'))[0]!.riskFlagged, false)
  stub.riskFlagged = true
  assert.equal((await stub.search('WETH'))[0]!.riskFlagged, true)
})

function limitRequest(limit: string, expireTime?: string) {
  return {
    targetChain: 'base',
    contraChain: 'base',
    targetAsset: stubOpts.weth,
    contraAsset: stubOpts.usdc,
    side: 'buy',
    qty: '5',
    orderType: 'limit',
    limitCrossPrice: limit,
    ...(expireTime ? { expireTime } : {}),
    funderAddress: funder.address,
    attachedBracket: { takeProfit: { notionalPrice: '3060' }, stopLoss: { notionalPrice: '2900' } },
  } as const
}

async function submitLimit(stub: LocalFlashStub, limit: string, expireTime?: string) {
  const { attachedBracket: _b, ...base } = limitRequest(limit, expireTime)
  const q = await stub.quote(limitRequest(limit, expireTime))
  const sign = (json: string) => funder.signTypedData(JSON.parse(json))
  return stub.submitOrder({
    ...base,
    quoteId: q.quoteId,
    userSignature: await sign(q.evm!.orderTypedData!),
    evmOrderTypedData: q.evm!.orderTypedData!,
    attachedBracket: {
      takeProfit: { notionalPrice: '3060' },
      stopLoss: { notionalPrice: '2900' },
      userSignature: await sign(q.attachedBracket!.evm!.orderTypedData),
      salt: q.attachedBracket!.salt!,
      deadline: q.attachedBracket!.deadline,
      signedMaxFromAmount: q.attachedBracket!.signedMaxFromAmount,
    },
  })
}

test('stub: a limit buy rests above the market, fills on the dip, then its bracket goes live', async () => {
  const stub = new LocalFlashStub(stubOpts) // price 3000
  const { orderId } = await submitLimit(stub, '2950')
  const resting = await stub.getOrder(orderId, funder.address)
  assert.equal(resting.order.status, 'ORDER_STATUS_ACCEPTED')
  assert.equal(resting.fills.length, 0)
  assert.equal(resting.order.attachedBracket, null, 'no bracket before the first fill')

  stub.setPrice(2990) // not low enough
  assert.equal((await stub.getOrder(orderId, funder.address)).order.status, 'ORDER_STATUS_ACCEPTED')

  stub.setPrice(2940) // the dip
  const filled = await stub.getOrder(orderId, funder.address)
  assert.equal(filled.order.status, 'ORDER_STATUS_FILLED')
  assert.equal(filled.fills.length, 1)
  assert.ok(Number(filled.fills[0]!.fillPrice) <= 2950, 'filled at the limit or better')
  const bracketId = filled.order.attachedBracket!.bracketOrderId!
  const bracket = (await stub.getOrder(bracketId, funder.address)).order
  assert.equal(bracket.status, 'ORDER_STATUS_ACCEPTED')
  assert.equal(bracket.qty, filled.order.filled!.targetAmount)
})

test('stub: a limit already at or below the market fills at once', async () => {
  const stub = new LocalFlashStub(stubOpts)
  const { orderId } = await submitLimit(stub, '3100')
  assert.equal((await stub.getOrder(orderId, funder.address)).order.status, 'ORDER_STATUS_FILLED')
})

test('stub: a limit that never triggers expires, and a cancel works while it rests', async () => {
  let now = 1_000_000
  const stub = new LocalFlashStub({ ...stubOpts, now: () => now })
  const expires = new Date(now + 60_000).toISOString()
  const { orderId } = await submitLimit(stub, '2950', expires)
  now += 61_000
  const o = await stub.getOrder(orderId, funder.address)
  assert.equal(o.order.status, 'ORDER_STATUS_CANCELLED')
  assert.equal(o.order.closeReason, 'REASON_ORDER_EXPIRED')
  stub.setPrice(2000) // an expired order never fills
  assert.equal((await stub.getOrder(orderId, funder.address)).fills.length, 0)

  stub.setPrice(3000)
  const second = await submitLimit(stub, '2950')
  await stub.cancelOrder(
    second.orderId,
    await funder.signMessage({ message: cancelMessage(second.orderId) }),
  )
  stub.setPrice(2000)
  const c = await stub.getOrder(second.orderId, funder.address)
  assert.equal(c.order.status, 'ORDER_STATUS_CANCELLED')
  assert.equal(c.fills.length, 0)
})
