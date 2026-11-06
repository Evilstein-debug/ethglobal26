import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compareDecimal, predictionSchema, tradeIntentSchema } from './schemas'

const intent = {
  version: 1,
  intentId: '0b5d6a3e-5f1c-4f6e-9a3b-2c1d0e9f8a7b',
  roundId: 7,
  agentAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  asset: 'WETH',
  side: 'long',
  entryRefPrice: '3000.00',
  sizeQuote: '5.00',
  orderType: 'bracket',
  stopPrice: '2950.00',
  targetPrice: '3060.00',
  rationale: 'breakout',
  zeroG: { requestId: '0852f405-6c56-40c2-a800-e6fd70785065', model: 'glm-5.3' },
  createdAt: '2026-11-06T10:00:00.000Z',
}

const prediction = {
  version: 1,
  predictionId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
  roundId: 7,
  entryId: 12,
  predictorKind: 'agent',
  predictor: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  side: 'YES',
  probYesBps: 6200,
  rationale: 'good win rate',
  zeroG: { requestId: 'req_2', model: 'glm-5.3' },
  createdAt: '2026-11-06T10:01:00.000Z',
}

test('a valid long bracket intent parses', () => {
  assert.equal(tradeIntentSchema.parse(intent).asset, 'WETH')
})

test('shorts, other assets and unknown fields are rejected', () => {
  assert.equal(tradeIntentSchema.safeParse({ ...intent, side: 'short' }).success, false)
  assert.equal(tradeIntentSchema.safeParse({ ...intent, asset: 'PEPE' }).success, false)
  assert.equal(tradeIntentSchema.safeParse({ ...intent, leverage: 10 }).success, false)
})

test('stop must be below entry and target above it', () => {
  assert.equal(tradeIntentSchema.safeParse({ ...intent, stopPrice: '3000.00' }).success, false)
  assert.equal(tradeIntentSchema.safeParse({ ...intent, targetPrice: '2999.99' }).success, false)
})

test('numbers must be plain positive decimal strings', () => {
  for (const sizeQuote of ['0', '-1', '1e3', '5.', 5]) {
    assert.equal(
      tradeIntentSchema.safeParse({ ...intent, sizeQuote }).success,
      false,
      `${sizeQuote}`,
    )
  }
})

test('compareDecimal is exact', () => {
  assert.equal(compareDecimal('0.1', '0.10'), 0)
  assert.equal(compareDecimal('2950.000000000000000001', '2950'), 1)
})

test('prediction side must agree with its probability', () => {
  assert.equal(predictionSchema.safeParse(prediction).success, true)
  assert.equal(predictionSchema.safeParse({ ...prediction, probYesBps: 4000 }).success, false)
  assert.equal(predictionSchema.safeParse({ ...prediction, probYesBps: 10_001 }).success, false)
})

test('agent predictions need a 0G ref; owner picks must not have one', () => {
  assert.equal(predictionSchema.safeParse({ ...prediction, zeroG: null }).success, false)
  const owner = { ...prediction, predictorKind: 'owner', zeroG: null }
  assert.equal(predictionSchema.safeParse(owner).success, true)
  assert.equal(predictionSchema.safeParse({ ...owner, zeroG: prediction.zeroG }).success, false)
})
