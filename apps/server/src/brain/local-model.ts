/**
 * LOCAL TEST ONLY: a deterministic stand-in "model" for anvil, so rounds run end to end without
 * a 0G key. Every decision it makes is recorded with model "local-stub" and a "local-" request
 * ID, and the UI labels them. Never used when ZEROG_API_KEY is set or on a real chain.
 */
import { LocalLLMStub, type ChatRequest } from '@starter/zerog'
import { ALLOCATION_SYSTEM, PREDICTION_SYSTEM, TRADE_SYSTEM } from './prompts'

function dataOf(req: ChatRequest): Record<string, unknown> {
  const m = /<<<DATA\n([\s\S]*)\nDATA>>>/.exec(req.user)
  return m ? (JSON.parse(m[1]!) as Record<string, unknown>) : {}
}

export function localModel() {
  return new LocalLLMStub((req) => {
    const data = dataOf(req)
    if (req.system === ALLOCATION_SYSTEM) {
      const limits = data.limits as { roundTradeCap: number }
      return JSON.stringify({
        trade: true,
        tradeBudget: Math.min(limits.roundTradeCap, 5),
        rationale: 'local stub: always trades',
      })
    }
    if (req.system === TRADE_SYSTEM) {
      const price = data.livePriceUsd as number
      const limits = data.limits as { maxSizeUsdc: number }
      if (limits.maxSizeUsdc < 1)
        return JSON.stringify({ action: 'hold', rationale: 'local stub: no budget left' })
      return JSON.stringify({
        action: 'buy',
        sizeQuote: Math.min(limits.maxSizeUsdc, 5),
        stopPrice: +(price * 0.99).toFixed(2),
        targetPrice: +(price * 1.015).toFixed(2),
        rationale: 'local stub: fixed 1% stop / 1.5% target',
      })
    }
    if (req.system === PREDICTION_SYSTEM) {
      const entries = data.entries as {
        entryId: number
        history: { wins: number; losses: number }
      }[]
      return JSON.stringify({
        predictions: entries.map((e) => {
          const games = e.history.wins + e.history.losses
          const p = games ? Math.round((e.history.wins / games) * 10_000) : 5500
          return {
            entryId: e.entryId,
            side: p >= 5000 ? 'YES' : 'NO',
            probYesBps: p,
            rationale: 'local stub: win rate',
          }
        }),
      })
    }
    return '{}'
  })
}
