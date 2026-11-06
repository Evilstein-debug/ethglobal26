'use client'

import { useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useState } from 'react'
import { useAccount } from 'wagmi'
import { Badge, Button, Empty, Field, PageHeader, Panel, Select, short } from '@/components/ui'
import { api, errorText, ethAmount, useApi, useOwnerAuth } from '@/lib/api'
import type { AgentView } from '@/lib/types'

function CreateAgent() {
  const getAuth = useOwnerAuth()
  const queryClient = useQueryClient()
  const [form, setForm] = useState({
    name: '',
    mode: 'both',
    perTradeCap: '5',
    dailyCap: '20',
    predictionsPerDay: '50',
  })
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setMessage(null)
    try {
      const agent = await api<AgentView>('/api/agents', {
        auth: await getAuth(),
        body: {
          name: form.name,
          mode: form.mode,
          policy: {
            perTradeCap: form.perTradeCap,
            dailyCap: form.dailyCap,
            predictionsPerDay: Number(form.predictionsPerDay),
          },
        },
      })
      setMessage({
        ok: true,
        text: `Created ${agent.name}. Fund it with USDC (and a little ETH for gas) from its page.`,
      })
      await queryClient.invalidateQueries()
    } catch (err) {
      setMessage({ ok: false, text: errorText(err) })
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-4 md:grid-cols-3">
      <Field label="Name" value={form.name} onChange={set('name')} required maxLength={40} />
      <Select label="Mode" value={form.mode} onChange={set('mode')}>
        <option value="both">Trade + predict</option>
        <option value="trade">Trade only</option>
        <option value="predict">Predict only</option>
      </Select>
      <Field
        label="Predictions / day"
        type="number"
        min={0}
        max={500}
        value={form.predictionsPerDay}
        onChange={set('predictionsPerDay')}
      />
      <Field
        label="Max per trade (USDC)"
        value={form.perTradeCap}
        onChange={set('perTradeCap')}
        inputMode="decimal"
      />
      <Field
        label="Max per day (USDC)"
        value={form.dailyCap}
        onChange={set('dailyCap')}
        inputMode="decimal"
      />
      <div className="flex items-center gap-3 md:col-span-3">
        <Button type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create agent'}
        </Button>
        {message && (
          <span className={`text-sm ${message.ok ? 'text-ok' : 'text-bad'}`}>{message.text}</span>
        )}
      </div>
      <p className="text-sm leading-relaxed text-mute md:col-span-3">
        The agent gets its own wallet. It can only trade WETH through Definitive Flash, commit to
        TradeLog, predict in Arena and send funds back to you. Limits are enforced by code; the
        model can&apos;t change them.
      </p>
    </form>
  )
}

function Body() {
  const { address } = useAccount()
  const { data } = useApi<{ verified: boolean; agents: AgentView[] }>(
    address ? `/api/owners/${address}` : null,
    10_000,
  )
  if (!address) return <Empty>Connect a wallet to see your agents.</Empty>
  if (!data) return <Empty>Loading…</Empty>
  if (!data.verified) {
    return (
      <Empty>
        Verify you&apos;re a unique human first:{' '}
        <Link className="font-medium text-ink underline underline-offset-4" href="/onboard">
          verify with World ID
        </Link>
        .
      </Empty>
    )
  }
  return (
    <>
      <Panel title="New agent">
        <CreateAgent />
      </Panel>
      <section className="grid gap-4 md:grid-cols-2">
        {data.agents.length ? (
          data.agents.map((a) => (
            <Panel key={a.id} title={a.mode}>
              <div className="flex items-center justify-between">
                <Link
                  href={`/agents/${a.id}`}
                  className="text-[18px] font-medium text-ink underline-offset-4 hover:underline"
                >
                  {a.name}
                </Link>
                <Badge tone={a.status === 'active' ? 'ok' : 'bad'}>{a.status}</Badge>
              </div>
              <p className="font-mono text-xs text-mute">{short(a.address)}</p>
              <p className="text-sm text-body">
                {a.balances
                  ? `${a.balances.usdc} USDC · ${ethAmount(a.balances.eth)} ETH`
                  : 'balance unavailable'}
              </p>
            </Panel>
          ))
        ) : (
          <Panel title="Agents" className="md:col-span-2">
            <Empty>No agents yet.</Empty>
          </Panel>
        )}
      </section>
    </>
  )
}

export default function Agents() {
  return (
    <div className="flex flex-col gap-8">
      <PageHeader eyebrow="My agents" title="Your agents, your limits.">
        <p>
          Each agent gets its own wallet, funded only with what you send. You set the caps; plain
          code enforces them, and the model never can change them.
        </p>
      </PageHeader>
      <Body />
    </div>
  )
}
