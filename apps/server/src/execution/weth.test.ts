import assert from 'node:assert/strict'
import { test } from 'node:test'
import { FlashApiError, type FlashAsset } from '@starter/flash'
import type { FlashSetup } from '../context'
import {
  BASE_WETH,
  FLASH_BLOCKED_MS,
  FLASH_REFRESH_MS,
  PRICE_TTL_MS,
  riskGuard,
  wethInfo,
} from './weth'

const asset = (over: Partial<FlashAsset> = {}): FlashAsset => ({
  chain: 'base',
  address: BASE_WETH,
  symbol: 'WETH',
  name: 'Wrapped Ether',
  decimals: 18,
  price: '3000',
  liquidity: '1000000',
  riskFlagged: false,
  ...over,
})

/** A real (non-stub) Flash setup whose /search is scripted and counted. */
function fakeFlash(search: () => Promise<FlashAsset[]>, chain = 'base') {
  const calls = { n: 0 }
  const flash = {
    chain,
    api: {
      search: async () => {
        calls.n++
        return search()
      },
    },
  } as unknown as FlashSetup
  return { flash, calls }
}

const refused = () =>
  Promise.reject(new FlashApiError(403, 'SEARCH_NOT_ELIGIBLE', 'Insufficient Flash usage.'))
const spot = (price: number) => async () => price

test('weth: Flash answers → its price and risk flag', async () => {
  const { flash } = fakeFlash(async () => [asset({ price: '3100' })])
  const info = await wethInfo(flash, { now: 1, fetchSpot: spot(1) })
  assert.equal(info.source, 'flash')
  assert.equal(info.price, 3100)
  assert.equal(info.riskFlagged, false)
  assert.equal(riskGuard(info, flash, BASE_WETH), null)
})

test('weth: Flash refuses /search → Coinbase price, and the guard passes canonical Base WETH', async () => {
  const { flash } = fakeFlash(refused)
  const info = await wethInfo(flash, { now: 1, fetchSpot: spot(2950) })
  assert.equal(info.source, 'coinbase')
  assert.equal(info.price, 2950)
  assert.equal(info.flashRefused, true)
  assert.equal(info.riskFlagged, null)
  assert.equal(riskGuard(info, flash, BASE_WETH), null)
  assert.equal(riskGuard(info, flash, BASE_WETH.toUpperCase().replace('0X', '0x')), null)
})

test('weth guard: the refusal exception covers only canonical WETH on Base', async () => {
  const { flash } = fakeFlash(refused)
  const info = await wethInfo(flash, { now: 1, fetchSpot: spot(2950) })
  assert.equal(
    riskGuard(info, flash, '0x1111111111111111111111111111111111111111'),
    'asset_check_failed',
  )
  const { flash: other } = fakeFlash(refused, 'ethereum')
  const otherInfo = await wethInfo(other, { now: 1, fetchSpot: spot(2950) })
  assert.equal(riskGuard(otherInfo, other, BASE_WETH), 'asset_check_failed')
})

test('weth guard: a plain lookup failure still refuses, even for canonical WETH', async () => {
  const { flash } = fakeFlash(() => Promise.reject(new Error('network down')))
  const info = await wethInfo(flash, { now: 1, fetchSpot: spot(2950) })
  assert.equal(info.source, 'coinbase')
  assert.equal(info.flashRefused, false)
  assert.equal(riskGuard(info, flash, BASE_WETH), 'asset_check_failed')
  assert.equal(riskGuard(null, flash, BASE_WETH), 'asset_check_failed')
})

test('weth guard: a Flash risk flag always refuses', async () => {
  const { flash } = fakeFlash(async () => [asset({ riskFlagged: true })])
  const info = await wethInfo(flash, { now: 1, fetchSpot: spot(1) })
  assert.equal(riskGuard(info, flash, BASE_WETH), 'asset_risk_flagged')
})

test('weth: Flash is asked at most once per refresh window; prices in between come from Coinbase', async () => {
  const { flash, calls } = fakeFlash(async () => [asset()])
  await wethInfo(flash, { now: 0, fetchSpot: spot(1) })
  await wethInfo(flash, { now: 1_000, fetchSpot: spot(1) })
  const later = await wethInfo(flash, { now: PRICE_TTL_MS + 1, fetchSpot: spot(3010) })
  assert.equal(calls.n, 1)
  assert.equal(later.source, 'coinbase')
  assert.equal(later.price, 3010)
  assert.equal(later.riskFlagged, false, 'keeps the last Flash risk flag')
  await wethInfo(flash, { now: FLASH_REFRESH_MS, fetchSpot: spot(1) })
  assert.equal(calls.n, 2)
})

test('weth: after a refusal Flash is left alone for the blocked window', async () => {
  const { flash, calls } = fakeFlash(refused)
  await wethInfo(flash, { now: 0, fetchSpot: spot(1) })
  await wethInfo(flash, { now: FLASH_REFRESH_MS + 1, fetchSpot: spot(1) })
  await wethInfo(flash, { now: FLASH_BLOCKED_MS - 1, fetchSpot: spot(1) })
  assert.equal(calls.n, 1)
  await wethInfo(flash, { now: FLASH_BLOCKED_MS, fetchSpot: spot(1) })
  assert.equal(calls.n, 2)
})

test('weth: no price from either source throws instead of returning zero', async () => {
  const { flash } = fakeFlash(refused)
  await assert.rejects(wethInfo(flash, { now: 0, fetchSpot: spot(0) }))
})
