/**
 * One place that answers "what is WETH worth, and is it risk-flagged?" for the watcher, the
 * decision step, the agents' get_market tool, manual trades and the trade risk guard.
 *
 * Flash's /search is rationed per key (403 SEARCH_NOT_ELIGIBLE once a key uses it too much), so:
 *  - Flash is asked at most once per FLASH_REFRESH_MS, and not at all for FLASH_BLOCKED_MS after
 *    it refuses;
 *  - between Flash answers the price comes from Coinbase's ETH-USD spot, cached for PRICE_TTL_MS;
 *  - the risk flag is Flash's last answer. If Flash has refused us and never answered, the flag is
 *    unknown (null) and only the trade guard decides what that means (see riskGuard below).
 * The local stub is always asked directly: dev tools move its price and expect it at once.
 */
import { FlashApiError, type FlashAsset } from '@starter/flash'
import type { FlashSetup } from '../context'

/** Canonical WETH9 predeploy on Base: the only asset the guard may pass without a Flash answer. */
export const BASE_WETH = '0x4200000000000000000000000000000000000006'

export const FLASH_REFRESH_MS = 5 * 60_000
export const FLASH_BLOCKED_MS = 30 * 60_000
export const PRICE_TTL_MS = 20_000

const SPOT_URL = 'https://api.coinbase.com/v2/prices/ETH-USD/spot'

export type WethInfo = {
  price: number
  /** Flash's risk flag; null when Flash has never answered this server. */
  riskFlagged: boolean | null
  source: 'flash' | 'coinbase'
  /** True while Flash is refusing /search for this key (SEARCH_NOT_ELIGIBLE). */
  flashRefused: boolean
  /** Flash's last full answer (24h stats), possibly a few minutes old. */
  asset?: FlashAsset
}

type State = {
  flash?: { at: number; asset: FlashAsset }
  spot?: { at: number; price: number }
  blockedUntil: number
}
const states = new WeakMap<FlashSetup, State>()

export type WethDeps = { now?: number; fetchSpot?: () => Promise<number> }

export function isSearchRefused(err: unknown) {
  return err instanceof FlashApiError && (err.code === 'SEARCH_NOT_ELIGIBLE' || err.status === 403)
}

async function coinbaseSpot(): Promise<number> {
  const res = await fetch(SPOT_URL, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`Coinbase spot ${res.status}`)
  const body = (await res.json()) as { data?: { amount?: string } }
  return Number(body.data?.amount)
}

export async function wethInfo(flash: FlashSetup, deps: WethDeps = {}): Promise<WethInfo> {
  if (flash.stub) {
    const [asset] = await flash.api.search('WETH', flash.chain, 1)
    if (!asset) throw new Error('WETH not found')
    return {
      price: Number(asset.price),
      riskFlagged: asset.riskFlagged,
      source: 'flash',
      flashRefused: false,
      asset,
    }
  }

  const now = deps.now ?? Date.now()
  let state = states.get(flash)
  if (!state) states.set(flash, (state = { blockedUntil: 0 }))

  const flashDue = !state.flash || now - state.flash.at >= FLASH_REFRESH_MS
  if (flashDue && now >= state.blockedUntil) {
    try {
      const [asset] = await flash.api.search('WETH', flash.chain, 1)
      if (asset && Number(asset.price) > 0) state.flash = { at: now, asset }
    } catch (err) {
      if (isSearchRefused(err)) {
        state.blockedUntil = now + FLASH_BLOCKED_MS
        console.warn(
          `[weth] Flash /search refused (${err instanceof Error ? err.message : err}); using Coinbase prices for ${FLASH_BLOCKED_MS / 60_000} min`,
        )
      } else {
        console.warn('[weth] Flash /search failed; using Coinbase price:', err)
      }
    }
  }

  const flashRefused = now < state.blockedUntil
  const last = state.flash
  if (last && now - last.at < PRICE_TTL_MS) {
    return {
      price: Number(last.asset.price),
      riskFlagged: last.asset.riskFlagged,
      source: 'flash',
      flashRefused,
      asset: last.asset,
    }
  }

  if (!state.spot || now - state.spot.at >= PRICE_TTL_MS) {
    const price = await (deps.fetchSpot ?? coinbaseSpot)()
    if (!(price > 0)) throw new Error('no WETH price from Flash or Coinbase')
    state.spot = { at: now, price }
  }
  return {
    price: state.spot.price,
    riskFlagged: last?.asset.riskFlagged ?? null,
    source: 'coinbase',
    flashRefused,
    asset: last?.asset,
  }
}

/**
 * The trade risk guard's verdict. Flagged → refuse. Cleared by Flash → allow. Unknown → refuse,
 * except when Flash is refusing /search for this key AND the asset is canonical Base WETH9: the
 * one allowlisted asset, whose risk flag is not in doubt. A plain lookup failure still refuses.
 */
export function riskGuard(info: WethInfo | null, flash: FlashSetup, wethAddress: string) {
  if (info?.riskFlagged === true) return 'asset_risk_flagged' as const
  if (info?.riskFlagged === false) return null
  const canonical = flash.chain === 'base' && wethAddress.toLowerCase() === BASE_WETH
  return info?.flashRefused && canonical ? null : ('asset_check_failed' as const)
}
