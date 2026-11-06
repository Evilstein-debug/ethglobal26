/**
 * Makes the agents react to the market instead of only a timer. Every poll reads the live WETH
 * price from Flash; when it has moved far enough since the last wake-up, trading agents are woken
 * to think now. A minimum gap keeps a choppy market from burning model calls. Flash has no price
 * push, so this polls. The wake itself only sets "think on the next tick": the agent's own checks
 * (cooldown, open position, caps) still decide whether a model call happens.
 */
import { eq, inArray, and } from 'drizzle-orm'
import type { AppContext } from '../context'
import { wethInfo } from '../execution/weth'
import { schema } from '../db'
import { logActivity, wakeAgent } from '../services/activity'

export type WatchState = { refPrice: number | null; lastWakeAt: number }
export type WatchOpts = { movePct: number; minGapMs: number }

/** Pure: decide whether this price is a big enough move. Mutates `state`. */
export function checkMove(state: WatchState, price: number, now: number, opts: WatchOpts) {
  if (!(price > 0)) return null
  if (state.refPrice === null) {
    state.refPrice = price
    return null
  }
  const changePct = (price / state.refPrice - 1) * 100
  if (Math.abs(changePct) < opts.movePct) return null
  // Too soon after the last wake-up: keep the old reference so the move keeps counting.
  if (now - state.lastWakeAt < opts.minGapMs) return null
  state.refPrice = price
  state.lastWakeAt = now
  return { changePct: Math.round(changePct * 100) / 100, price }
}

export function startPriceWatcher(ctx: AppContext, opts: WatchOpts & { pollMs: number }) {
  const flash = ctx.flash
  if (!flash) return () => {}
  const state: WatchState = { refPrice: null, lastWakeAt: 0 }
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      const { price } = await wethInfo(flash)
      const move = checkMove(state, price, ctx.now(), opts)
      if (!move) return
      const traders = await ctx.db
        .select({ id: schema.agents.id })
        .from(schema.agents)
        .where(
          and(eq(schema.agents.status, 'active'), inArray(schema.agents.mode, ['trade', 'both'])),
        )
      const text = `WETH moved ${move.changePct > 0 ? '+' : ''}${move.changePct}% to $${move.price}: waking up to reassess`
      for (const { id } of traders) {
        await logActivity(ctx, id, 'idle', text)
        await wakeAgent(ctx, id)
      }
      console.log(`[watcher] ${text} (${traders.length} agents)`)
    } catch (err) {
      console.error('[watcher] poll failed:', err instanceof Error ? err.message : err)
    } finally {
      running = false
    }
  }, opts.pollMs)
  return () => clearInterval(timer)
}
