'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useAccount } from 'wagmi'
import { Badge, Button, Empty, Panel, short } from '@/components/ui'
import { useApi } from '@/lib/api'

type AgentNow = {
  id: string
  name: string
  mode: string
  owner: string
  state: string
  detail: string
  nextThinkAt: number | null
}
type ActivityEvent = {
  id: number
  agentId: string
  agentName: string
  state: string
  message: string
  rationale: string | null
  entryId: number | null
  at: number
  decision: {
    requestId: string
    teeVerified: boolean | null
    accepted: boolean | null
    rejectReason: string | null
  } | null
}
type Activity = { serverTime: number; agents: AgentNow[]; events: ActivityEvent[] }

const STATE_LABEL: Record<string, string> = {
  idle: 'Idle',
  reading_news: 'Reading news',
  thinking: 'Thinking',
  trading: 'Trading',
  predicting: 'Planning a prediction',
  watching_position: 'Watching its trade',
  cooling_down: 'Cooling down',
  needs_funds: 'Needs funds',
  error: 'Problem',
  paused: 'Paused',
  broadcast: 'Broadcast',
  resolved: 'Resolved',
}
const BUSY = ['reading_news', 'thinking', 'trading', 'predicting']

const label = (state: string) => STATE_LABEL[state] ?? state

function tone(state: string) {
  if (state === 'error' || state === 'needs_funds') return 'bad' as const
  return BUSY.includes(state) || state === 'broadcast' ? ('ok' as const) : ('muted' as const)
}

function AgentCard({ agent, serverTime }: { agent: AgentNow; serverTime: number }) {
  const wait = agent.nextThinkAt ? Math.ceil((agent.nextThinkAt - serverTime) / 1000) : 0
  return (
    <Panel title={agent.mode}>
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/agents/${agent.id}`}
          className="font-semibold underline-offset-4 hover:underline"
        >
          {agent.name}
        </Link>
        <Badge tone={tone(agent.state)}>{label(agent.state)}</Badge>
      </div>
      <p className="text-sm">{agent.detail}</p>
      <p className="text-xs text-muted">
        {BUSY.includes(agent.state) || agent.state === 'paused'
          ? ' '
          : wait > 0
            ? `Thinks again in ${wait}s`
            : 'About to think'}
      </p>
    </Panel>
  )
}

function Decision({ d }: { d: NonNullable<ActivityEvent['decision']> }) {
  return (
    <span className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-muted">
      <span title={d.requestId}>0G {short(d.requestId)}</span>
      {d.teeVerified === true && <Badge tone="ok">TEE verified</Badge>}
      {d.teeVerified !== true && <Badge>no TEE</Badge>}
      {d.accepted === false && (
        <Badge tone="bad">rejected: {d.rejectReason?.replaceAll('_', ' ')}</Badge>
      )}
    </span>
  )
}

function Row({ e }: { e: ActivityEvent }) {
  return (
    <li className="flex flex-col gap-1 border-b border-line py-3 last:border-0">
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-mono text-xs text-muted">{new Date(e.at).toLocaleTimeString()}</span>
        <Link href={`/agents/${e.agentId}`} className="font-semibold">
          {e.agentName}
        </Link>
        <Badge tone={tone(e.state)}>{label(e.state)}</Badge>
        <span>{e.message}</span>
        {e.entryId != null && (
          <Link href={`/entries/${e.entryId}`} className="text-xs underline">
            View entry
          </Link>
        )}
      </div>
      {e.rationale && <p className="text-sm text-muted">“{e.rationale}”</p>}
      {e.decision && <Decision d={e.decision} />}
    </li>
  )
}

export default function LivePage() {
  const { address } = useAccount()
  const [mine, setMine] = useState(false)
  const { data, error } = useApi<Activity>(
    mine && address ? `/api/activity?owner=${address}` : '/api/activity',
    1500,
  )

  if (error) return <Empty>Server unreachable.</Empty>
  if (!data) return <Empty>Loading…</Empty>

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted">
          Agents act on their own. Everything they read, think and do shows up here as it happens,
          including their reasoning and any decision the guardrails rejected.
        </p>
        {address && (
          <Button variant="outline" onClick={() => setMine(!mine)}>
            {mine ? 'Show all agents' : 'Show only my agents'}
          </Button>
        )}
      </div>

      {data.agents.length ? (
        <section className="grid gap-px border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
          {data.agents.map((a) => (
            <AgentCard key={a.id} agent={a} serverTime={data.serverTime} />
          ))}
        </section>
      ) : (
        <Empty>
          {mine ? 'You have no agents yet.' : 'No agents yet.'}{' '}
          <Link href="/agents" className="underline">
            Create one
          </Link>
        </Empty>
      )}

      <Panel title="Activity">
        {data.events.length ? (
          <ul className="flex flex-col">
            {data.events.map((e) => (
              <Row key={e.id} e={e} />
            ))}
          </ul>
        ) : (
          <Empty>Nothing yet. Fund an agent and it starts thinking.</Empty>
        )}
      </Panel>
    </div>
  )
}
