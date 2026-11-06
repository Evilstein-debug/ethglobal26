/**
 * LOCAL TEST ONLY: a deterministic stand-in "model" for anvil, so markets run end to end without
 * a 0G key. Every decision it makes is recorded with model "local-stub" and a "local-" request
 * ID, and the UI labels them. Never used when ZEROG_API_KEY is set or on a real chain.
 */
import { LocalLLMStub, type ChatRequest } from '@starter/zerog'
import { THINK_SYSTEM } from './prompts'

function dataOf(req: ChatRequest): Record<string, unknown> {
  const m = /<<<DATA\n([\s\S]*)\nDATA>>>/.exec(req.user)
  return m ? (JSON.parse(m[1]!) as Record<string, unknown>) : {}
}

type ThinkData = {
  actions: { trade: boolean; predict: boolean }
  you: { history: { trades: number } }
  market: { livePriceUsd: number }
  limits: {
    maxSizeUsdc: number
    twap?: { minMinutes: number; minBuckets: number; minSliceUsdc: number }
    limit?: { minDipPct: number; minWaitMinutes: number }
  }
  openMarkets: { entryId: number; history: { wins: number; losses: number } }[]
}

export function localModel() {
  return new LocalLLMStub((req) => {
    if (req.system !== THINK_SYSTEM) return '{}'
    const data = dataOf(req) as ThinkData
    if (data.actions.predict && data.openMarkets.length) {
      return JSON.stringify({
        action: 'predict',
        predictions: data.openMarkets.map((m) => {
          const games = m.history.wins + m.history.losses
          const p = games ? Math.round((m.history.wins / games) * 10_000) : 5500
          return {
            entryId: m.entryId,
            side: p >= 5000 ? 'YES' : 'NO',
            probYesBps: p,
            rationale: 'local stub: uses the trader win rate',
          }
        }),
      })
    }
    if (data.actions.trade) {
      const price = data.market.livePriceUsd
      const size = Math.min(data.limits.maxSizeUsdc, 5)
      const t = data.limits.twap
      // Alternates so a local run shows both entry styles: every second trade is built in tranches.
      const turn = data.you.history.trades % 3
      const twap =
        t && turn === 1 && size / t.minBuckets >= t.minSliceUsdc
          ? { style: 'twap', durationMinutes: t.minMinutes, buckets: t.minBuckets }
          : {}
      // Every third trade rests a limit buy a little under the market, so the waiting path shows.
      const l = data.limits.limit
      if (l && turn === 2) {
        const limitPrice = +(price * (1 - Math.max(l.minDipPct, 0.2) / 100)).toFixed(2)
        return JSON.stringify({
          action: 'buy',
          sizeQuote: size,
          style: 'limit',
          limitPrice,
          waitMinutes: l.minWaitMinutes,
          stopPrice: +(limitPrice * 0.99).toFixed(2),
          targetPrice: +(limitPrice * 1.015).toFixed(2),
          rationale: 'local stub: rests a limit buy 0.2% under the market',
        })
      }
      return JSON.stringify({
        action: 'buy',
        sizeQuote: size,
        stopPrice: +(price * 0.99).toFixed(2),
        targetPrice: +(price * 1.015).toFixed(2),
        ...twap,
        rationale: 'local stub: fixed 1% stop / 1.5% target',
      })
    }
    return JSON.stringify({ action: 'wait', rationale: 'local stub: nothing to do' })
  })
}
