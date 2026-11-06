import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { cancelMessage, isCancelMessage } from './cancel'
import { FlashApiError, FlashClient } from './client'
import { LocalFlashStub } from './stub'

const ORDER_ID = '6bdb29aa-1b2c-4d3e-8f90-123456789abc'

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
    flashIntegratorFeeBps: '0',
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
    flashIntegratorFeeBps: '0',
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

test('stub: approvals are requested once per token', async () => {
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
  assert.equal((await stub.quote(req)).evm!.approveTx, null)
})
