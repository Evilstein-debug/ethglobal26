/**
 * LOCAL ANVIL ONLY: the real ETH/USD spot price drives the Flash stub, so agents see a real market
 * and brackets fire on real moves. Fills stay simulated until Flash is live; only the price is real.
 */
import type { LocalFlashStub } from '@starter/flash'
import { z } from 'zod'

const spot = z.object({ data: z.object({ amount: z.coerce.number().positive() }) })

export async function fetchSpotPrice(url: string) {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) })
  if (!res.ok) throw new Error(`price feed: HTTP ${res.status}`)
  return spot.parse(await res.json()).data.amount
}

/** Resolves on the first real price, so nothing ever trades on the stub's placeholder price. */
export async function startPriceFeed(stub: LocalFlashStub, url: string, everyMs = 5000) {
  for (;;) {
    try {
      stub.setPrice(await fetchSpotPrice(url))
      break
    } catch (err) {
      console.error('[prices] waiting for the first real price:', err)
      await new Promise((r) => setTimeout(r, everyMs))
    }
  }
  const timer = setInterval(() => {
    fetchSpotPrice(url).then(
      (price) => stub.setPrice(price),
      (err) => console.error('[prices] keeping the last real price:', err),
    )
  }, everyMs)
  return () => clearInterval(timer)
}
