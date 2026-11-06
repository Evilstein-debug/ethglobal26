import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { candleReader, parseCandles, summarizeCandles, type Candle } from './candles'
import { describeDecision, type MemoryRow } from './memory'
import { checkMove, type WatchState } from './watcher'

/** n candles of `step` seconds starting at price p0 and rising `drift` per candle. */
function series(n: number, step: number, p0: number, drift: number): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const open = p0 + drift * i
    const close = open + drift
    return { t: i * step, low: open - 1, high: close + 1, open, close }
  })
}

describe('candles', () => {
  test('parses Coinbase rows (newest first) into oldest-first candles and drops junk', () => {
    const rows = [
      [200, 9, 12, 10, 11, 5],
      [100, 8, 11, 9, 10, 5],
      ['x', 1, 1, 1, 1, 1],
      [50, 1, 1],
    ]
    const parsed = parseCandles(rows)
    assert.deepEqual(
      parsed.map((c) => c.t),
      [100, 200],
    )
    assert.deepEqual(parsed[1], { t: 200, low: 9, high: 12, open: 10, close: 11 })
    assert.deepEqual(parseCandles({ message: 'rate limited' }), [])
  })

  test('summary: changes, range and distance from the high', () => {
    const hourly = series(24, 3600, 2000, 5) // 2000 → 2120
    const fiveMin = series(12, 300, 2108, 1) // 2108 → 2120
    const s = summarizeCandles({ hourly, fiveMin })!
    assert.equal(s.priceUsd, 2120)
    assert.equal(s.change1hPct, 0.57) // 2108 → 2120
    assert.equal(s.change24hPct, 6) // 2000 → 2120
    assert.equal(s.high24hUsd, 2121)
    assert.equal(s.low24hUsd, 1999)
    assert.equal(s.belowHigh24hPct, -0.05)
    assert.equal(s.hoursCovered, 24)
  })

  test('summary is null with too little data, and never invents numbers', () => {
    assert.equal(summarizeCandles(null), null)
    assert.equal(summarizeCandles({ hourly: series(3, 3600, 2000, 1), fiveMin: [] }), null)
  })

  test('reader caches for a minute, and a failing API gives null instead of throwing', async () => {
    let calls = 0
    let t = 0
    const ok = (async () => {
      calls++
      return new Response(JSON.stringify([[100, 1, 2, 1, 2, 1]]))
    }) as typeof fetch
    const read = candleReader(ok, () => t)
    assert.ok(await read())
    await read()
    assert.equal(calls, 2) // two granularities, one fetch round
    t = 61_000
    await read()
    assert.equal(calls, 4)

    const bad = (async () => new Response('nope', { status: 429 })) as typeof fetch
    assert.equal(await candleReader(bad)(), null)
  })
})

describe('memory', () => {
  const base: MemoryRow = {
    kind: 'think',
    raw_output: JSON.stringify({ action: 'wait', rationale: 'flat market' }),
    created_at: 1_000_000,
    intent_state: null,
    fail_reason: null,
    outcome: null,
    pnl_bps: null,
  }
  const now = 1_000_000 + 12 * 60_000

  test('a wait keeps its reason', () => {
    assert.deepEqual(describeDecision(base, now), {
      minutesAgo: 12,
      did: 'wait',
      why: 'flat market',
      result: null,
    })
  })

  test('a trade shows how it ended', () => {
    const buy = { ...base, kind: 'trade', intent_state: 'EXECUTED' }
    assert.equal(
      describeDecision({ ...buy, outcome: 'PENDING' }, now).result,
      'position still open',
    )
    assert.equal(
      describeDecision({ ...buy, outcome: 'YES', pnl_bps: '85' }, now).result,
      'profit (+0.85% after fees)',
    )
    assert.equal(
      describeDecision({ ...buy, outcome: 'NO', pnl_bps: -120 }, now).result,
      'no profit (-1.2% after fees)',
    )
    assert.equal(describeDecision({ ...buy, outcome: 'VOID' }, now).result, 'voided, no result')
    assert.match(
      describeDecision({ ...buy, intent_state: 'FAILED', fail_reason: 'no_fill' }, now).result!,
      /order failed \(no_fill\)/,
    )
  })

  test('a long or messy past rationale is clipped and a bad blob does not throw', () => {
    const long = { ...base, raw_output: JSON.stringify({ rationale: 'x'.repeat(1000) }) }
    assert.equal(describeDecision(long, now).why.length, 160)
    assert.equal(describeDecision({ ...base, raw_output: 'not json' }, now).why, '')
  })
})

describe('price watcher', () => {
  const opts = { movePct: 0.5, minGapMs: 60_000 }
  const fresh = (): WatchState => ({ refPrice: null, lastWakeAt: 0 })

  test('the first price only sets the reference', () => {
    const s = fresh()
    assert.equal(checkMove(s, 2000, 1_000_000, opts), null)
    assert.equal(s.refPrice, 2000)
  })

  test('small moves do nothing; a big move wakes once and resets the reference', () => {
    const s = fresh()
    checkMove(s, 2000, 1_000_000, opts)
    assert.equal(checkMove(s, 2005, 1_010_000, opts), null) // +0.25%
    assert.deepEqual(checkMove(s, 2020, 1_020_000, opts), { changePct: 1, price: 2020 })
    assert.equal(s.refPrice, 2020)
    assert.equal(checkMove(s, 2021, 1_030_000, opts), null)
  })

  test('works for drops too, and the minimum gap holds a move until it can fire', () => {
    const s = fresh()
    checkMove(s, 2000, 1_000_000, opts)
    assert.ok(checkMove(s, 1980, 1_000_000 + 61_000, opts)) // -1%
    assert.equal(checkMove(s, 1950, 1_000_000 + 70_000, opts), null) // big, but too soon
    assert.equal(s.refPrice, 1980) // kept, so the move keeps counting
    assert.ok(checkMove(s, 1950, 1_000_000 + 130_000, opts))
  })

  test('ignores a bad price', () => {
    const s = fresh()
    assert.equal(checkMove(s, 0, 1, opts), null)
    assert.equal(checkMove(s, Number.NaN, 1, opts), null)
    assert.equal(s.refPrice, null)
  })
})
