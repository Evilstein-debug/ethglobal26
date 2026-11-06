/**
 * Price history for the agents. Flash has no candles endpoint, so this reads Coinbase's public
 * candles (no key) and boils them down to a few numbers. It is context only: the live price used
 * for trades still comes from Flash. Any failure returns null and the agent simply sees no candles.
 */

export type Candle = { t: number; low: number; high: number; open: number; close: number }
export type CandleSet = { hourly: Candle[]; fiveMin: Candle[] }

export const CANDLE_SOURCE = 'Coinbase ETH-USD public candles'
const BASE = 'https://api.exchange.coinbase.com/products/ETH-USD/candles'
const TIMEOUT_MS = 5000
const CACHE_MS = 60_000

/** Coinbase rows are [time, low, high, open, close, volume], newest first. */
export function parseCandles(rows: unknown): Candle[] {
  if (!Array.isArray(rows)) return []
  return rows
    .flatMap((r): Candle[] => {
      if (!Array.isArray(r) || r.length < 5) return []
      const [t, low, high, open, close] = r.slice(0, 5).map(Number) as [
        number,
        number,
        number,
        number,
        number,
      ]
      return [t, low, high, open, close].every(Number.isFinite) && close > 0
        ? [{ t, low, high, open, close }]
        : []
    })
    .sort((a, b) => a.t - b.t)
}

export function candleReader(fetchFn: typeof fetch = fetch, now: () => number = Date.now) {
  let cache: { at: number; set: CandleSet | null } | null = null
  const get = async (granularity: number) => {
    const res = await fetchFn(`${BASE}?granularity=${granularity}`, {
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return parseCandles(await res.json())
  }
  return async (): Promise<CandleSet | null> => {
    if (cache && now() - cache.at < CACHE_MS) return cache.set
    let set: CandleSet | null = null
    try {
      const [hourly, fiveMin] = await Promise.all([get(3600), get(300)])
      set = { hourly, fiveMin }
    } catch (err) {
      console.error('[candles]', err instanceof Error ? err.message : err)
    }
    cache = { at: now(), set }
    return set
  }
}

const pct = (from: number, to: number) => Math.round((to / from - 1) * 10_000) / 100
const r2 = (n: number) => Math.round(n * 100) / 100

/** A handful of numbers a model can reason about. Null when there is too little data. */
export function summarizeCandles(set: CandleSet | null) {
  if (!set) return null
  const hourly = set.hourly.slice(-24)
  const fiveMin = set.fiveMin.slice(-12)
  if (hourly.length < 6 || fiveMin.length < 6) return null
  const last = fiveMin.at(-1)!.close
  const high = Math.max(...hourly.map((c) => c.high))
  const low = Math.min(...hourly.map((c) => c.low))
  const ranges = hourly.map((c) => ((c.high - c.low) / c.open) * 100)
  return {
    source: CANDLE_SOURCE,
    priceUsd: r2(last),
    change1hPct: pct(fiveMin[0]!.open, last),
    change6hPct: pct(hourly.at(-6)!.open, last),
    change24hPct: pct(hourly[0]!.open, last),
    hoursCovered: hourly.length,
    high24hUsd: r2(high),
    low24hUsd: r2(low),
    belowHigh24hPct: pct(high, last),
    avgHourlyRangePct: r2(ranges.reduce((a, b) => a + b, 0) / ranges.length),
  }
}
