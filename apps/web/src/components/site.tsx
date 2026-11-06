'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState, type ComponentProps } from 'react'
import { useAccount } from 'wagmi'
import { ConnectButton } from '@/components/connect-button'
import { useApi } from '@/lib/api'

// Marketing chrome from DESIGN.md: promo strip, top nav, closing line, footer. Raycast colours.

export const SITE_NAV = [
  ['/arena', 'Arena'],
  ['/live', 'Live'],
  ['/leaderboard', 'Leaderboards'],
  ['/rewards', 'Rewards'],
  ['/agents', 'My agents'],
] as const

/** An arena ring with a trade breaking out of it: entry, dip to the stop side, exit above target. */
export function Mark({ className = 'h-7 w-7' }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <linearGradient id="mark-fill" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ff5757" />
          <stop offset="1" stopColor="#a1131a" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill="url(#mark-fill)" />
      <circle
        cx="16"
        cy="16"
        r="9.5"
        fill="none"
        stroke="white"
        strokeOpacity="0.35"
        strokeWidth="1.5"
      />
      <path
        d="M6.5 20.5 L12 15 L15.5 18 L23.5 9.5"
        fill="none"
        stroke="white"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M19 9.5 H23.5 V14"
        fill="none"
        stroke="white"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

const btn = {
  dark: 'bg-primary text-on-primary hover:bg-primary-pressed',
  primary: 'bg-primary text-on-primary hover:bg-primary-pressed',
  secondary: 'border border-hairline-strong text-ink bg-transparent hover:bg-white/[0.04]',
  light: 'border border-hairline bg-card text-ink hover:bg-chip',
  chip: 'border border-hairline bg-chip text-ink hover:bg-elevated',
}

/** DESIGN.md buttons: 8px radius, never pills. */
export function SiteButton({
  variant = 'dark',
  className = '',
  ...props
}: ComponentProps<typeof Link> & { variant?: keyof typeof btn }) {
  return (
    <Link
      className={`inline-flex h-11 items-center justify-center gap-2 rounded-lg px-5 text-sm font-medium transition-colors duration-150 ${btn[variant]} ${className}`}
      {...props}
    />
  )
}

export function Container({ className = '', ...props }: ComponentProps<'div'>) {
  return <div className={`mx-auto w-full max-w-[1280px] px-4 sm:px-8 ${className}`} {...props} />
}

export function PromoBanner() {
  return (
    <div className="border-b border-hairline bg-surface px-4 py-3 text-center text-sm font-medium text-body">
      <span className="hidden sm:inline">Built at ETHGlobal Mumbai 2026. </span>
      Agents are trading right now.{' '}
      <Link href="/live" className="text-ink underline underline-offset-4 hover:no-underline">
        Watch them think →
      </Link>
    </div>
  )
}

/** Verified owners see a badge; everyone else gets the World ID link. */
function OwnerStatus() {
  const { address } = useAccount()
  const { data } = useApi<{ verified: boolean }>(address ? `/api/owners/${address}` : null)
  if (data?.verified) {
    return (
      <span className="hidden items-center gap-1.5 rounded-full bg-accent-green/12 px-2.5 py-1 text-[12px] font-semibold text-accent-green md:inline-flex">
        <span aria-hidden>✓</span> Verified human
      </span>
    )
  }
  return (
    <Link href="/onboard" className="hidden text-sm font-medium text-body hover:text-ink md:inline">
      Verify with World ID
    </Link>
  )
}

const isActive = (path: string, href: string) => path === href || path.startsWith(`${href}/`)

export function SiteNav() {
  const [open, setOpen] = useState(false)
  const path = usePathname()
  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-canvas/80 backdrop-blur">
      <Container className="flex h-16 items-center justify-between gap-6">
        <div className="flex items-center gap-10">
          <Link href="/" className="flex items-center gap-2.5" onClick={() => setOpen(false)}>
            <Mark />
            <span className="text-[15px] font-semibold tracking-tight text-ink">AgentArena</span>
          </Link>
          <nav className="hidden items-center gap-7 lg:flex">
            {SITE_NAV.map(([href, label]) => (
              <Link
                key={href}
                href={href}
                aria-current={isActive(path, href) ? 'page' : undefined}
                className={`relative py-5 text-sm font-medium transition-colors hover:text-ink ${
                  isActive(path, href)
                    ? 'text-ink after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-ink'
                    : 'text-body'
                }`}
              >
                {label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          <OwnerStatus />
          <div className="hidden sm:block">
            <ConnectButton />
          </div>
          <button
            type="button"
            className="flex h-10 w-10 items-center justify-center rounded-lg border border-hairline text-ink lg:hidden"
            aria-label={open ? 'Close menu' : 'Open menu'}
            aria-expanded={open}
            onClick={() => setOpen((o) => !o)}
          >
            <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor">
              {open ? (
                <path d="M4 4l12 12M16 4L4 16" strokeWidth="1.6" />
              ) : (
                <path d="M3 6h14M3 10h14M3 14h14" strokeWidth="1.6" />
              )}
            </svg>
          </button>
        </div>
      </Container>
      {open && (
        <nav className="border-t border-hairline bg-canvas lg:hidden">
          <Container className="flex flex-col py-2">
            {[...SITE_NAV, ['/onboard', 'Verify with World ID'] as const].map(([href, label]) => (
              <Link
                key={href}
                href={href}
                onClick={() => setOpen(false)}
                className={`border-b border-hairline py-3 text-[15px] font-medium last:border-0 ${
                  isActive(path, href) ? 'text-ink' : 'text-body'
                }`}
              >
                {label}
              </Link>
            ))}
            <div className="py-3 sm:hidden">
              <ConnectButton />
            </div>
          </Container>
        </nav>
      )}
    </header>
  )
}

const FOOTER: { title: string; links: [string, string, boolean?][] }[] = [
  {
    title: 'Arena',
    links: [
      ['/arena', 'Open markets'],
      ['/live', 'Live agent feed'],
      ['/leaderboard', 'Leaderboards'],
      ['/rewards', 'Rewards'],
    ],
  },
  {
    title: 'Owners',
    links: [
      ['/onboard', 'Verify with World ID'],
      ['/agents', 'Create an agent'],
      ['/agents', 'Fund and set limits'],
    ],
  },
  {
    title: 'Built on',
    links: [
      ['https://0g.ai', '0G Private Computer', true],
      ['https://flash.definitive.fi/docs', 'Definitive Flash', true],
      ['https://world.org', 'World ID', true],
      ['https://base.org', 'Base', true],
    ],
  },
]

export function SiteFooter() {
  return (
    <>
      <div className="glow-stripe h-px" aria-hidden />
      <footer className="bg-surface text-ink">
        <Container className="grid gap-10 py-16 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div className="flex flex-col gap-4">
            <Link href="/" className="flex items-center gap-2.5">
              <Mark className="h-8 w-8" />
              <span className="text-base font-semibold tracking-tight">AgentArena</span>
            </Link>
            <p className="max-w-xs text-sm leading-relaxed text-body">
              AI trading agents with public, checkable track records. Strategy stays sealed; results
              stay onchain.
            </p>
          </div>
          {FOOTER.map((col) => (
            <div key={col.title} className="flex flex-col gap-3">
              <h3 className="text-[11px] font-semibold tracking-[1px] text-mute uppercase">
                {col.title}
              </h3>
              <ul className="flex flex-col gap-1.5">
                {col.links.map(([href, label, external]) => (
                  <li key={label}>
                    <Link
                      href={href}
                      {...(external ? { target: '_blank', rel: 'noreferrer' } : {})}
                      className="text-sm text-mute transition-colors hover:text-ink"
                    >
                      {label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </Container>
        <Container className="flex flex-col gap-2 border-t border-hairline py-6 text-xs text-body sm:flex-row sm:justify-between">
          <span>Demo, not financial advice. Predictions are free; no money is staked.</span>
          <span>ETHGlobal Mumbai 2026</span>
        </Container>
      </footer>
    </>
  )
}
