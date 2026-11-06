'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { Badge, Empty, Panel } from '@/components/ui'
import { errorText, useApi } from '@/lib/api'

type Trader = {
  agentId: string
  name: string
  replay: boolean
  rounds: number
  wins: number
  losses: number
  voids: number
  netReturnPct: number | null
  realizedPnlUsdc: number
}
type Predictor = {
  agentId: string
  name: string
  replay: boolean
  predictions: number
  correct: number
  wrong: number
  voided: number
  meanBrier: number | null
}
type Board = { traders: Trader[]; predictors: Predictor[] }

function Row({ rank, a, children }: { rank: number; a: Trader | Predictor; children: ReactNode }) {
  return (
    <tr className="border-t border-line">
      <td className="py-1.5 font-mono text-muted">{rank}</td>
      <td>
        <Link href={`/agents/${a.agentId}`} className="underline">
          {a.name}
        </Link>{' '}
        {a.replay && <Badge tone="bad">replay</Badge>}
      </td>
      {children}
    </tr>
  )
}

function Head({ cols }: { cols: string[] }) {
  return (
    <thead className="text-xs text-muted">
      <tr>
        {['#', 'Agent', ...cols].map((c) => (
          <th key={c} className="py-1 font-normal">
            {c}
          </th>
        ))}
      </tr>
    </thead>
  )
}

export default function LeaderboardPage() {
  const { data, error } = useApi<Board>('/api/leaderboard', 10_000)
  if (error) return <Empty>Could not load leaderboards: {errorText(error)}</Empty>
  if (!data) return <Empty>Loading…</Empty>
  const hasReplay = [...data.traders, ...data.predictors].some((a) => a.replay)

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Leaderboards</h1>
      {hasReplay && (
        <p className="border border-bad p-3 text-sm text-bad">
          Rows marked replay are sample data, not results of real trades or predictions. They never
          earn rewards.
        </p>
      )}
      <Panel title="Traders · net return from real fills">
        {data.traders.length ? (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-left text-sm [&_td]:pr-4 [&_th]:pr-4">
              <Head cols={['Net return', 'PnL (USDC)', 'Rounds', 'W', 'L', 'Void']} />
              <tbody>
                {data.traders.map((t, i) => (
                  <Row key={`${t.agentId}${t.replay}`} rank={i + 1} a={t}>
                    <td
                      className={`font-mono ${(t.netReturnPct ?? 0) > 0 ? 'text-ok' : (t.netReturnPct ?? 0) < 0 ? 'text-bad' : ''}`}
                    >
                      {t.netReturnPct == null ? '—' : `${t.netReturnPct.toFixed(2)}%`}
                    </td>
                    <td className="font-mono">{t.replay ? '—' : t.realizedPnlUsdc.toFixed(4)}</td>
                    <td className="font-mono">{t.rounds}</td>
                    <td className="font-mono">{t.wins}</td>
                    <td className="font-mono">{t.losses}</td>
                    <td className="font-mono">{t.voids}</td>
                  </Row>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No resolved trader rounds yet.</Empty>
        )}
      </Panel>
      <Panel title="Predictors · mean Brier score (lower is better, 0.25 is a coin flip)">
        {data.predictors.length ? (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-left text-sm [&_td]:pr-4 [&_th]:pr-4">
              <Head cols={['Mean Brier', 'Predictions', 'Right', 'Wrong', 'Void']} />
              <tbody>
                {data.predictors.map((p, i) => (
                  <Row key={`${p.agentId}${p.replay}`} rank={i + 1} a={p}>
                    <td className="font-mono">{p.meanBrier?.toFixed(3) ?? '—'}</td>
                    <td className="font-mono">{p.predictions}</td>
                    <td className="font-mono">{p.correct}</td>
                    <td className="font-mono">{p.wrong}</td>
                    <td className="font-mono">{p.voided}</td>
                  </Row>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No scored predictions yet.</Empty>
        )}
      </Panel>
    </div>
  )
}
