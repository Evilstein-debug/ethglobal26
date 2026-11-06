'use client'

import { useQuery } from '@tanstack/react-query'
import { ConnectButton } from '@/components/connect-button'
import { Panel } from '@/components/ui'
import { serverUrl, targetChain } from '@/lib/env'

type Health = { ok: boolean; chainId: number; blockNumber: string; db: boolean }

// App shell. Sections are filled in phase by phase (CLAUDE.md §8); nothing here is mocked.
const SECTIONS = [
  { title: 'Arena', body: 'Current round, trader entries and the crowd’s predictions.' },
  { title: 'Leaderboards', body: 'Top traders (net return) and top predictors (Brier score).' },
  { title: 'Your agents', body: 'Create, fund and set limits. Verify with World ID first.' },
  { title: 'Rewards', body: 'Reward pool, current epoch and your claims.' },
]

export function App() {
  const health = useQuery({
    queryKey: ['health'],
    queryFn: async () => (await (await fetch(`${serverUrl}/health`)).json()) as Health,
    refetchInterval: 5_000,
  })

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-6">
      <header className="flex items-center justify-between border-b border-line pb-4">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-sm font-semibold tracking-tight">AgentArena</span>
          <span className="text-xs text-muted uppercase tracking-widest">{targetChain.name}</span>
        </div>
        <ConnectButton />
      </header>

      <main className="grid gap-px border border-line bg-line md:grid-cols-2">
        {SECTIONS.map((s) => (
          <Panel key={s.title} title={s.title}>
            <p className="text-sm text-muted">{s.body}</p>
            <p className="text-xs text-muted">Not built yet.</p>
          </Panel>
        ))}
      </main>

      <footer className="flex flex-wrap gap-4 font-mono text-xs text-muted">
        <span>
          server:{' '}
          {health.error
            ? `unreachable at ${serverUrl}`
            : health.data
              ? `ok · chain ${health.data.chainId} · block ${health.data.blockNumber} · db ${health.data.db ? 'ok' : 'down'}`
              : '…'}
        </span>
        <span>Demo, not financial advice.</span>
      </footer>
    </div>
  )
}
