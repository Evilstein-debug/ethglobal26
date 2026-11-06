'use client'

import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'
import { DevWalletFunds } from '@/components/dev-tools'
import { Container, SiteFooter, SiteNav } from '@/components/site'
import { useHealth } from '@/lib/api'

/** Labels anything that isn't real: local stubs and dev verification. */
export function Labels() {
  const { data } = useHealth()
  if (!data) return null
  const labels = [
    data.flash === 'local-stub' && 'Flash: local stub (fake fills)',
    typeof data.llm === 'object' && data.llm.kind === 'local-stub' && 'Model: local stub (not 0G)',
    data.humanVerifier === 'dev' && 'Identity: dev (not World ID)',
  ].filter(Boolean)
  if (!labels.length) return null
  return (
    <div className="flex flex-wrap gap-2">
      {labels.map((l) => (
        <span
          key={String(l)}
          className="rounded-full bg-accent-red/10 px-2.5 py-1 text-[12px] font-semibold text-accent-red"
        >
          {l}
        </span>
      ))}
    </div>
  )
}

export function Shell({ children }: { children: ReactNode }) {
  const path = usePathname()
  // The landing page lays out its own full-width sections.
  if (path === '/') return <>{children}</>
  return (
    <div className="flex min-h-screen flex-col bg-canvas text-ink">
      <SiteNav />
      <main className="flex-1">
        <Container className="flex flex-col gap-8 py-10 sm:py-14">
          <Labels />
          <DevWalletFunds />
          {children}
        </Container>
      </main>
      <div className="mt-16">
        <SiteFooter />
      </div>
    </div>
  )
}
