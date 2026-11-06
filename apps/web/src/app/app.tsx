'use client'

import { arenaAbi } from '@starter/shared/generated'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { zeroHash } from 'viem'
import { useAccount } from 'wagmi'
import { TxStatus } from '@/components/tx-status'
import { Badge, Button, Empty, Panel } from '@/components/ui'
import { useApi, useHealth } from '@/lib/api'
import { useTx } from '@/lib/use-tx'

type Entry = {
  id: number
  onchainEntryId: number | null
  trader: { id: string; name: string; address: string; owner: string }
  outcome: 'PENDING' | 'YES' | 'NO' | 'VOID'
  pnlBps: number | null
  voidReason: string | null
  tradeBudgetUsdc: number | null
  predictions: { yes: number; no: number; avgProbYesBps: number | null }
}
type Round = {
  id?: number
  phase?: string
  phaseEndsAt?: number
  serverTime: number
  entries?: Entry[]
}

const PHASE_HELP: Record<string, string> = {
  REGISTRATION: 'Agents decide (on 0G) whether to trade this round and with how much.',
  PREDICTING: 'Agents and owners call YES/NO on each trader. Free: nothing is staked.',
  TRADING: 'Predictions are locked onchain. Traders commit each trade, then execute on Flash.',
  RESOLVING: 'Positions are closed and PnL is computed from Flash fills.',
  SETTLED: 'Round over. Next round starts shortly.',
}

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
      <label className="flex items-center gap-2 text-xs text-muted">
        P(YES)
        <input
          type="range"
          min={0}
          max={100}
          value={prob}
          onChange={(e) => setProb(Number(e.target.value))}
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

export function App() {
  const { data: round, error } = useApi<Round>('/api/rounds/current', 3000)
  const { data: health } = useHealth()
  const { address } = useAccount()
  const { data: owner } = useApi<{ verified: boolean }>(address ? `/api/owners/${address}` : null)

  if (error) return <Empty>Server unreachable.</Empty>
  if (!round) return <Empty>Loading…</Empty>
  if (!round.id) return <Empty>No round yet. The first one starts automatically.</Empty>

  return (
    <div className="flex flex-col gap-6">
      <Panel title={`Round ${round.id}`}>
        <div className="flex flex-wrap items-baseline justify-between gap-4">
          <p className="text-2xl font-semibold tracking-tight">{round.phase}</p>
          {round.phase !== 'SETTLED' && round.phaseEndsAt && (
            <p className="text-sm text-muted">
              ends in <Countdown endsAt={round.phaseEndsAt} serverTime={round.serverTime} />
            </p>
          )}
        </div>
        <p className="text-sm text-muted">{PHASE_HELP[round.phase ?? ''] ?? ''}</p>
      </Panel>

      <section className="grid gap-px border border-line bg-line md:grid-cols-2">
        {round.entries?.length ? (
          round.entries.map((e) => {
            const total = e.predictions.yes + e.predictions.no
            return (
              <Panel key={e.id} title={`Entry #${e.onchainEntryId ?? e.id}`}>
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <Link
                      href={`/agents/${e.trader.id}`}
                      className="font-semibold underline-offset-4 hover:underline"
                    >
                      {e.trader.name}
                    </Link>
                    <p className="text-xs text-muted">
                      Will {e.trader.name} end this round in profit?
                    </p>
                  </div>
                  <OutcomeBadge e={e} />
                </div>
                <div className="flex h-2 w-full bg-line" aria-label="prediction split">
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
                  {e.tradeBudgetUsdc != null && ` · budget ${e.tradeBudgetUsdc} USDC`}
                </p>
                {round.phase === 'PREDICTING' &&
                  owner?.verified &&
                  health &&
                  (address?.toLowerCase() === e.trader.owner.toLowerCase() ? (
                    <p className="text-xs text-muted">
                      Your agent: you can&apos;t predict on it. Switch to another verified wallet to
                      pick.
                    </p>
                  ) : (
                    <ManualPick entry={e} arena={health.contracts.arena} />
                  ))}
                <Link href={`/entries/${e.id}`} className="text-xs underline">
                  Verify this entry →
                </Link>
              </Panel>
            )
          })
        ) : (
          <Panel title="Entries" className="md:col-span-2">
            <Empty>No trader entered this round yet.</Empty>
          </Panel>
        )}
      </section>
    </div>
  )
}
