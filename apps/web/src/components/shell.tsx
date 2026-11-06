'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { useAccount } from 'wagmi'
import { ConnectButton } from '@/components/connect-button'
import { DevWalletFunds } from '@/components/dev-tools'
import { useApi, useHealth } from '@/lib/api'
import { targetChain } from '@/lib/env'

const NAV = [
  ['/', 'Arena'],
  ['/live', 'Live'],
  ['/leaderboard', 'Leaderboards'],
  ['/rewards', 'Rewards'],
  ['/agents', 'My agents'],
] as const

/** Labels anything that isn't real: local stubs and dev verification. */
function Labels() {
  const { data } = useHealth()
  if (!data) return null
  const labels = [
    data.flash === 'local-stub' && 'Flash: LOCAL STUB (fake fills)',
    typeof data.llm === 'object' && data.llm.kind === 'local-stub' && 'Model: LOCAL STUB (not 0G)',
    data.humanVerifier === 'dev' && 'Identity: DEV (not World ID)',
  ].filter(Boolean)
  if (!labels.length) return null
  return (
    <div className="flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-widest">
      {labels.map((l) => (
        <span key={String(l)} className="border border-bad px-2 py-1 text-bad">
          {l}
        </span>
      ))}
    </div>
  )
}

function OwnerBadge() {
  const { address } = useAccount()
  const { data } = useApi<{ verified: boolean }>(address ? `/api/owners/${address}` : null)
  if (!address || !data) return null
  return data.verified ? (
    <span className="text-xs text-ok">✓ verified human</span>
  ) : (
    <Link href="/onboard" className="text-xs underline">
      Verify with World ID
    </Link>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname()
  return (
    <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-4 py-6">
      <header className="flex flex-col gap-4 border-b border-line pb-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-baseline gap-3">
            <Link href="/" className="font-mono text-sm font-semibold tracking-tight">
              AgentArena
            </Link>
            <span className="text-xs text-muted uppercase tracking-widest">{targetChain.name}</span>
          </div>
          <div className="flex items-center gap-3">
            <OwnerBadge />
            <ConnectButton />
          </div>
        </div>
        <nav className="flex flex-wrap gap-4 text-sm">
          {NAV.map(([href, label]) => (
            <Link
              key={href}
              href={href}
              className={
                path === href ? 'font-semibold underline underline-offset-4' : 'text-muted'
              }
            >
              {label}
            </Link>
          ))}
        </nav>
        <Labels />
        <DevWalletFunds />
      </header>
      <main className="flex flex-1 flex-col gap-6">{children}</main>
      <footer className="border-t border-line pt-4 text-xs text-muted">
        Demo, not financial advice. Trades are real onchain swaps through Definitive Flash; agent
        decisions come from 0G Private Computer; predictions are free (no money staked).
      </footer>
    </div>
  )
}
