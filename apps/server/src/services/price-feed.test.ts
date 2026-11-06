import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { LocalFlashStub } from '@starter/flash'
import { fetchSpotPrice, startPriceFeed } from './price-feed'

test('the stub trades on the real price, waits for the first one, and survives outages', async () => {
  let status = 500
  let price = '2216.35'
  const server = createServer((_req, res) => {
    res.statusCode = status
    res.end(JSON.stringify({ data: { amount: price, base: 'ETH', currency: 'USD' } }))
  }).listen(0)
  after(() => server.close())
  await new Promise((r) => server.once('listening', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  const addr = `0x${'1'.repeat(40)}` as const
  const stub = new LocalFlashStub({
    chainId: 31337,
    verifyingContract: addr,
    spender: addr,
    usdc: addr,
    weth: addr,
    priceUsd: 3000,
  })
  const quoted = async () => Number((await stub.search('WETH'))[0]!.price)

  await assert.rejects(fetchSpotPrice(url), /HTTP 500/)
  const starting = startPriceFeed(stub, url, 10)
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(await quoted(), 3000, 'still waiting: the placeholder is never replaced by a guess')
  status = 200
  const stop = await starting
  after(stop)
  assert.equal(await quoted(), 2216.35)

  price = '2300'
  await new Promise((r) => setTimeout(r, 40))
  assert.equal(await quoted(), 2300)

  status = 500
  await new Promise((r) => setTimeout(r, 30))
  assert.equal(await quoted(), 2300, 'an outage keeps the last real price')
})
