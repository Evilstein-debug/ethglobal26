'use client'

import Link from 'next/link'
import { useState } from 'react'
import { useAccount } from 'wagmi'
import { Badge, Button, Empty, PageHeader, Panel, short } from '@/components/ui'
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
  detail: string | null
  entryId: number | null
  at: number
  decision: {
    requestId: string
    teeVerified: boolean | null
    accepted: boolean | null
    rejectReason: string | null
    model: string | null
    latencyMs: number | null
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
  thought: 'Thought',
  tool_call: 'Tool call',
  tool_result: 'Tool result',
  twap: 'TWAP',
  flash: 'Flash',
}
const BUSY = ['reading_news', 'thinking', 'trading', 'predicting']
/** The agent's reasoning steps within one thought: drawn indented under the thought they belong to. */
const STEPS = ['thought', 'tool_call', 'tool_result']

const label = (state: string) => STATE_LABEL[state] ?? state

function tone(state: string) {
  if (state === 'error' || state === 'needs_funds') return 'bad' as const
  return BUSY.includes(state) || state === 'broadcast' || state === 'tool_call'
    ? ('ok' as const)
    : ('muted' as const)
}

/** A tool result's JSON, indented for reading; falls back to the raw text. */
function pretty(text: string) {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function AgentCard({ agent, serverTime }: { agent: AgentNow; serverTime: number }) {
  const wait = agent.nextThinkAt ? Math.ceil((agent.nextThinkAt - serverTime) / 1000) : 0
  return (
    <Panel title={agent.mode}>
      <div className="flex items-start justify-between gap-2">
        <Link
          href={`/agents/${agent.id}`}
          className="text-[18px] font-medium text-ink underline-offset-4 hover:underline"
        >
          {agent.name}
        </Link>
        <Badge tone={tone(agent.state)}>{label(agent.state)}</Badge>
      </div>
      <p className="text-sm leading-relaxed text-body">{agent.detail}</p>
      <p className="text-xs text-mute">
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
      {d.model && <span>{d.model}</span>}
      {d.latencyMs != null && <span>{(d.latencyMs / 1000).toFixed(1)}s</span>}
      {d.teeVerified === true && <Badge tone="ok">TEE verified</Badge>}
      {d.teeVerified !== true && <Badge>no TEE</Badge>}
      {d.accepted === false && (
        <Badge tone="bad">rejected: {d.rejectReason?.replaceAll('_', ' ')}</Badge>
      )}
    </span>
  )
}

function Row({ e }: { e: ActivityEvent }) {
  const step = STEPS.includes(e.state)
  return (
    <li
      className={`flex flex-col gap-1 border-b border-hairline py-4 last:border-0 ${
        step ? 'ml-4 border-l-2 border-l-hairline-strong pl-4' : ''
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-2 text-sm">
        <span className="font-mono text-xs text-muted">{new Date(e.at).toLocaleTimeString()}</span>
        <Link href={`/agents/${e.agentId}`} className="font-medium text-ink hover:underline">
          {e.agentName}
        </Link>
        <Badge tone={tone(e.state)}>{label(e.state)}</Badge>
        <span
          className={
            e.state === 'tool_call'
              ? 'font-mono text-xs'
              : e.state === 'thought'
                ? 'italic text-muted'
                : e.state === 'tool_result'
                  ? 'font-mono text-xs text-muted'
                  : ''
          }
        >
          {e.message}
        </span>
        {e.entryId != null && (
          <Link
            href={`/entries/${e.entryId}`}
            className="text-xs font-medium text-ink underline underline-offset-4"
          >
            View entry
          </Link>
        )}
      </div>
      {e.rationale && <p className="text-sm leading-relaxed text-body">“{e.rationale}”</p>}
      {e.detail && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">Full result</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg border border-hairline bg-elevated p-3 font-mono whitespace-pre-wrap break-all text-body">
            {pretty(e.detail)}
          </pre>
        </details>
      )}
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
    <div className="flex flex-col gap-10">
      <PageHeader
        eyebrow="Live"
        title="Watch agents think."
        actions={
          address && (
            <Button variant="outline" onClick={() => setMine(!mine)}>
              {mine ? 'Show all agents' : 'Show only my agents'}
            </Button>
          )
        }
      >
        <p>
          Agents act on their own. Everything they think, every tool they ask for and what came
          back, and every decision the guardrails rejected shows up here as it happens. Indented
          rows are the steps inside one thought.
        </p>
      </PageHeader>

      {data.agents.length ? (
        <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {data.agents.map((a) => (
            <AgentCard key={a.id} agent={a} serverTime={data.serverTime} />
          ))}
        </section>
      ) : (
        <Empty>
          {mine ? 'You have no agents yet.' : 'No agents yet.'}{' '}
          <Link href="/agents" className="font-medium text-ink underline underline-offset-4">
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
