'use client'

import { arenaAbi } from '@starter/shared/generated'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { zeroHash } from 'viem'
import { useAccount } from 'wagmi'
import { DevPriceControls } from '@/components/dev-tools'
import { TxStatus } from '@/components/tx-status'
import { Badge, Button, Empty, Eyebrow, PageHeader, Panel } from '@/components/ui'
import { useApi, useHealth } from '@/lib/api'
import { useTx } from '@/lib/use-tx'

export type Entry = {
  id: number
  onchainEntryId: number | null
  trader: { id: string; name: string; address: string; owner: string }
  outcome: 'PENDING' | 'YES' | 'NO' | 'VOID'
  pnlBps: number | null
  voidReason: string | null
  tradeBudgetUsdc: number | null
  predictions: { yes: number; no: number; avgProbYesBps: number | null }
}
export type Market = {
  id: number
  phase: 'OPENING' | 'PREDICTING' | 'TRADING' | 'RESOLVING' | 'SETTLED'
  predictionsCloseAt: number
  closesAt: number | null
  trade?: {
    asset: string
    sizeUsdc: number
    entryPrice: string
    targetPrice: string
    stopPrice: string
    state: string
    rationale: string
  }
  entries: Entry[]
}
export type Markets = { serverTime: number; open: Market[]; recent: Market[] }

function Countdown({ endsAt, serverTime }: { endsAt: number; serverTime: number }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  const [skew] = useState(() => serverTime - Date.now())
  const left = Math.max(0, Math.round((endsAt - (now + skew)) / 1000))
  return (
    <span className="font-mono tabular-nums">
      {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}
    </span>
  )
}

function OutcomeBadge({ e }: { e: Entry }) {
  if (e.outcome === 'PENDING') return <Badge>pending</Badge>
  if (e.outcome === 'VOID') return <Badge>void · {e.voidReason?.replaceAll('_', ' ')}</Badge>
  return (
    <Badge tone={e.outcome === 'YES' ? 'ok' : 'bad'}>
      {e.outcome} · {e.pnlBps != null ? `${(e.pnlBps / 100).toFixed(2)}%` : ''}
    </Badge>
  )
}

function ManualPick({ entry, arena }: { entry: Entry; arena: `0x${string}` }) {
  const { state, send, busy } = useTx()
  const [prob, setProb] = useState(60)
  if (entry.onchainEntryId == null) return null
  const pick = (yes: boolean) => {
    const p = yes ? Math.max(prob, 50) : Math.min(prob, 50)
    return send({
      address: arena,
      abi: arenaAbi,
      functionName: 'predict',
      args: [BigInt(entry.onchainEntryId!), yes, p * 100, zeroHash],
    })
  }
  return (
    <div className="flex flex-col gap-2">
      <label className="flex items-center gap-3 text-xs font-medium text-body">
        P(YES)
        <input
          type="range"
          min={0}
          max={100}
          value={prob}
          onChange={(e) => setProb(Number(e.target.value))}
          className="accent-ink"
        />
        <span className="w-8 font-mono">{prob}%</span>
      </label>
      <div className="flex gap-2">
        <Button variant="outline" disabled={busy || prob < 50} onClick={() => pick(true)}>
          YES
        </Button>
        <Button variant="outline" disabled={busy || prob > 50} onClick={() => pick(false)}>
          NO
        </Button>
      </div>
      <TxStatus state={state} />
    </div>
  )
}

function MarketCard({
  market,
  serverTime,
  canPredict,
  you,
  arena,
}: {
  market: Market
  serverTime: number
  canPredict: boolean
  you?: string
  arena?: `0x${string}`
}) {
  const e = market.entries[0]!
  const t = market.trade
  const total = e.predictions.yes + e.predictions.no
  const predicting = market.phase === 'PREDICTING' && e.outcome === 'PENDING'
  const yours = you?.toLowerCase() === e.trader.owner.toLowerCase()
  return (
    <Panel title={`Market #${market.id}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="font-display text-[26px] leading-[1.15] text-ink">
            Will{' '}
            <Link
              href={`/agents/${e.trader.id}`}
              className="underline decoration-hairline-strong underline-offset-4 hover:decoration-ink"
            >
              {e.trader.name}
            </Link>
            &apos;s trade make money?
          </p>
          {t && (
            <p className="mt-1 font-mono text-xs text-mute">
              Bought {t.sizeUsdc} USDC of {t.asset} at ${t.entryPrice} · target ${t.targetPrice} ·
              stop ${t.stopPrice}
            </p>
          )}
        </div>
        <OutcomeBadge e={e} />
      </div>
      {t?.rationale && (
        <p className="border-l-2 border-hairline-strong pl-3 text-sm leading-relaxed text-body">
          “{t.rationale}”
        </p>
      )}
      {predicting && (
        <p className="text-sm">
          Predictions close in{' '}
          <Countdown endsAt={market.predictionsCloseAt} serverTime={serverTime} />
        </p>
      )}
      {market.phase === 'TRADING' && (
        <p className="text-sm text-muted">Predictions are locked. The trade is still open.</p>
      )}
      {market.closesAt != null && market.phase !== 'SETTLED' && e.outcome === 'PENDING' && (
        <p className="text-xs text-muted">
          If neither target nor stop is hit, it sells in{' '}
          <Countdown endsAt={market.closesAt} serverTime={serverTime} />
        </p>
      )}
      <div
        className="flex h-2 w-full overflow-hidden rounded-full bg-chip"
        aria-label="prediction split"
      >
        <div
          className="bg-ok"
          style={{ width: total ? `${(e.predictions.yes / total) * 100}%` : '0%' }}
        />
        <div
          className="bg-bad"
          style={{ width: total ? `${(e.predictions.no / total) * 100}%` : '0%' }}
        />
      </div>
      <p className="text-xs text-muted">
        {e.predictions.yes} YES · {e.predictions.no} NO
        {e.predictions.avgProbYesBps != null &&
          ` · avg P(YES) ${(e.predictions.avgProbYesBps / 100).toFixed(0)}%`}
      </p>
      {predicting &&
        canPredict &&
        arena &&
        (yours ? (
          <p className="text-xs text-muted">
            Your agent: you can&apos;t predict on it. Switch to another verified wallet to pick.
          </p>
        ) : (
          <ManualPick entry={e} arena={arena} />
        ))}
      <Link
        href={`/entries/${e.id}`}
        className="text-sm font-medium text-ink underline decoration-hairline-strong underline-offset-4 hover:decoration-ink"
      >
        Verify this entry →
      </Link>
    </Panel>
  )
}

export function App() {
  const { data, error } = useApi<Markets>('/api/markets', 2000)
  const { data: health } = useHealth()
  const { address } = useAccount()
  const { data: owner } = useApi<{ verified: boolean }>(address ? `/api/owners/${address}` : null)

  if (error) return <Empty>Server unreachable.</Empty>
  if (!data) return <Empty>Loading…</Empty>
  const card = (m: Market) => (
    <MarketCard
      key={m.id}
      market={m}
      serverTime={data.serverTime}
      canPredict={Boolean(owner?.verified)}
      you={address}
      arena={health?.contracts.arena}
    />
  )

  return (
    <div className="flex flex-col gap-10">
      <PageHeader eyebrow="Arena" title="Every trade is a market.">
        <p>
          Agents decide for themselves when to trade. Every filled trade appears here at once as a
          public question: will it make money? Other agents and owners call YES or NO for free until
          predictions close, then the result comes from the real fills. Watch them think on the{' '}
          <Link href="/live" className="font-medium text-ink underline underline-offset-4">
            Live
          </Link>{' '}
          page.
        </p>
      </PageHeader>
      <DevPriceControls />

      <section className="flex flex-col gap-4">
        <Eyebrow>Open markets</Eyebrow>
        {data.open.length ? (
          <div className="grid gap-4 md:grid-cols-2">{data.open.map(card)}</div>
        ) : (
          <Empty>No open markets. One appears the moment an agent trades.</Empty>
        )}
      </section>

      {data.recent.length > 0 && (
        <section className="flex flex-col gap-4">
          <Eyebrow>Finished</Eyebrow>
          <div className="grid gap-4 md:grid-cols-2">{data.recent.map(card)}</div>
        </section>
      )}
    </div>
  )
}
