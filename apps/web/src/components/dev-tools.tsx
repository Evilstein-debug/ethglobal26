'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useState, type ReactNode } from 'react'
import { useAccount } from 'wagmi'
import { api, errorText, useHealth } from '@/lib/api'

const LOCAL_CHAIN_ID = 31337

function DevButton(props: { busy: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button
      className="border border-fg px-2 py-1 font-mono text-xs hover:bg-fg hover:text-bg disabled:opacity-40"
      disabled={props.busy}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  )
}

function useDevCall() {
  const queryClient = useQueryClient()
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<string | null>(null)
  async function run(path: string, body: unknown, done: string) {
    setBusy(true)
    setMsg(null)
    try {
      await api(path, { body })
      await queryClient.invalidateQueries()
      setMsg(done)
    } catch (err) {
      setMsg(errorText(err))
    } finally {
      setBusy(false)
    }
  }
  return { busy, msg, run }
}

/** LOCAL ANVIL ONLY: fills the connected wallet, so it can fund agents the way real users do. */
export function DevWalletFunds() {
  const { address } = useAccount()
  const { data: health } = useHealth()
  const { busy, msg, run } = useDevCall()
  if (!address || health?.chainId !== LOCAL_CHAIN_ID) return null
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <DevButton
        busy={busy}
        onClick={() =>
          run('/api/dev/faucet', { address }, 'Added 1,000 mock USDC + 20 ETH to your wallet.')
        }
      >
        {busy ? 'Sending…' : 'Add 1,000 USDC + 20 ETH to my wallet (local only)'}
      </DevButton>
      {msg && <span className="text-muted">{msg}</span>}
    </div>
  )
}

const PRICES = [
  { usd: 3000, label: '$3,000 reset' },
  { usd: 3100, label: '$3,100 price up' },
  { usd: 2900, label: '$2,900 price down' },
]

/** LOCAL ANVIL ONLY: moves the stub market so a bracket's take-profit or stop-loss can fire. */
export function DevPriceControls() {
  const { data: health } = useHealth()
  const { busy, msg, run } = useDevCall()
  if (health?.flash !== 'local-stub') return null
  if (health.livePrice) {
    return (
      <p className="border-t border-line pt-3 text-xs text-muted">
        WETH ${health.livePrice.toFixed(2)}, live from Coinbase. Fills are simulated until Flash is
        connected.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-3">
      <p className="text-xs text-muted">
        Fake market (local only). After an agent buys, click price up or down to hit its target or
        stop. Leave it alone and it sells at its time limit. Reset before the next trade.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {PRICES.map((p) => (
          <DevButton
            key={p.usd}
            busy={busy}
            onClick={() =>
              run('/api/dev/flash-stub/price', { priceUsd: p.usd }, `WETH is now $${p.usd}.`)
            }
          >
            {p.label}
          </DevButton>
        ))}
        {msg && <span className="text-xs text-muted">{msg}</span>}
      </div>
    </div>
  )
}
