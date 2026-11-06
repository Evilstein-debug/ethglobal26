'use client'

import { explorerAddressUrl } from '@starter/shared/chains'
import { useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { useState } from 'react'
import { erc20Abi, formatUnits, parseEther, parseUnits } from 'viem'
import { useAccount, useBalance, useReadContract } from 'wagmi'
import { DevWalletFunds } from '@/components/dev-tools'
import { TxStatus } from '@/components/tx-status'
import { Badge, Button, Empty, Field, Panel } from '@/components/ui'
import { api, errorText, useApi, useHealth, useOwnerAuth } from '@/lib/api'
import { targetChain } from '@/lib/env'
import { useTx } from '@/lib/use-tx'
import { ModelBadge, TxLink } from '@/components/links'
import type { AgentView } from '@/lib/types'

type Decision = {
  id: string
  roundId: number
  kind: string
  model: string
  requestId: string
  teeVerified: boolean | null
  accepted: boolean
  rejectReason: string | null
  rawOutput: string
  createdAt: number
}
type Intent = {
  intentId: string
  roundId: number
  state: string
  sizeQuote: number
  stopPrice: string
  targetPrice: string
  entryRefPrice: string
  commitTx: string | null
  recordTx: string | null
  entryFillTx: string | null
  exitFillTx: string | null
  usdcSpent: number | null
  usdcReceived: number | null
  failReason: string | null
}

/** What the connected wallet can send, so a failed send explains itself. */
function YourWallet({ usdc }: { usdc?: `0x${string}` }) {
  const { address } = useAccount()
  const { data: eth } = useBalance({ address })
  const { data: tokens } = useReadContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    query: { enabled: Boolean(usdc && address) },
  })
  if (tokens == null || !eth) return null
  return (
    <p className="text-sm text-mute">
      Your wallet: {formatUnits(tokens, 6)} USDC · {Number(formatUnits(eth.value, 18)).toFixed(4)}{' '}
      ETH
    </p>
  )
}

function OwnerControls({ agent }: { agent: AgentView }) {
  const getAuth = useOwnerAuth()
  const queryClient = useQueryClient()
  const { data: health } = useHealth()
  const fund = useTx()
  const gas = useTx()
  const [amount, setAmount] = useState('5')
  const [gasAmount, setGasAmount] = useState('0.01')
  const [withdrawAmt, setWithdrawAmt] = useState('1')
  const [msg, setMsg] = useState<string | null>(null)

  async function call(path: string, body?: unknown) {
    setMsg(null)
    try {
      await api(`/api/agents/${agent.id}/${path}`, {
        method: 'POST',
        body: body ?? {},
        auth: await getAuth(),
      })
      await queryClient.invalidateQueries()
      setMsg('Done.')
    } catch (err) {
      setMsg(errorText(err))
    }
  }

  return (
    <Panel title="Owner controls">
      <YourWallet usdc={health?.contracts.usdc} />
      <div className="grid gap-6 md:grid-cols-3">
        <div className="flex flex-col gap-2">
          <Field
            label="Fund with USDC"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
          />
          <Button
            variant="outline"
            disabled={fund.busy || !health}
            onClick={() =>
              fund.send({
                address: health!.contracts.usdc,
                abi: erc20Abi,
                functionName: 'transfer',
                args: [agent.address, parseUnits(amount || '0', 6)],
              })
            }
          >
            Send USDC to agent
          </Button>
          <TxStatus state={fund.state} />
        </div>
        <div className="flex flex-col gap-2">
          <Field
            label="Fund with ETH for gas"
            value={gasAmount}
            onChange={(e) => setGasAmount(e.target.value)}
            inputMode="decimal"
          />
          <Button
            variant="outline"
            disabled={gas.busy}
            onClick={() => gas.sendEth(agent.address, parseEther(gasAmount || '0'))}
          >
            Send ETH for gas
          </Button>
          <TxStatus state={gas.state} />
          <p className="text-xs text-muted">
            Agents pay gas for commits, approvals and predictions. A little goes a long way.
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <Field
            label="Withdraw USDC to you"
            value={withdrawAmt}
            onChange={(e) => setWithdrawAmt(e.target.value)}
            inputMode="decimal"
          />
          <Button
            variant="outline"
            onClick={() => call('withdraw', { asset: 'USDC', amount: withdrawAmt })}
          >
            Withdraw
          </Button>
          {agent.status === 'active' ? (
            <Button variant="outline" onClick={() => call('pause')}>
              Pause agent (stops all signing)
            </Button>
          ) : (
            <Button variant="outline" onClick={() => call('resume')}>
              Resume agent
            </Button>
          )}
        </div>
      </div>
      <DevWalletFunds />
      {msg && <p className="text-sm text-body">{msg}</p>}
    </Panel>
  )
}

export default function AgentPage() {
  const { id } = useParams<{ id: string }>()
  const { address } = useAccount()
  const { data: agent, error } = useApi<AgentView>(`/api/agents/${id}`, 10_000)
  const { data: activity } = useApi<{
    decisions: Decision[]
    stats: {
      role: string
      rounds: number
      wins: number
      losses: number
      voids: number
      replay: boolean
    }[]
  }>(`/api/agents/${id}/activity`, 10_000)
  const { data: history } = useApi<{ intents: Intent[] }>(`/api/agents/${id}/intents`, 10_000)
  if (error) return <Empty>Agent not found.</Empty>
  if (!agent) return <Empty>Loading…</Empty>
  const isOwner = address?.toLowerCase() === agent.owner.toLowerCase()
  const addrUrl = explorerAddressUrl(targetChain, agent.address)

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-3 border-b border-hairline pb-8">
        <p className="text-[11px] font-semibold tracking-[1px] text-mute uppercase">
          {agent.mode} agent
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-display text-[44px] leading-[1.05] tracking-[-1px] text-ink md:text-[56px]">
            {agent.name}
          </h1>
          <Badge tone={agent.status === 'active' ? 'ok' : 'bad'}>{agent.status}</Badge>
        </div>
        <p className="font-mono text-xs text-mute">
          wallet{' '}
          {addrUrl ? (
            <a
              className="text-ink underline underline-offset-4"
              href={addrUrl}
              target="_blank"
              rel="noreferrer"
            >
              {agent.address} ↗
            </a>
          ) : (
            agent.address
          )}
        </p>
        <p className="text-[16px] text-body">
          {agent.balances
            ? `${agent.balances.usdc} USDC · ${Number(agent.balances.eth).toFixed(4)} ETH${agent.balances.weth ? ` · ${Number(agent.balances.weth).toFixed(6)} WETH` : ''}`
            : 'balance unavailable'}
          {Number(agent.reservedUsdc) > 0 &&
            ` · ${agent.reservedUsdc} USDC reserved for an in-flight trade`}
        </p>
        {agent.policy && (
          <p className="text-xs text-muted">
            Limits: {agent.policy.perTradeCap} / trade · {agent.policy.dailyCap} / day USDC · assets{' '}
            {agent.policy.tokenAllowlist.join(', ')} · {agent.policy.predictionsPerDay} predictions
            / day
          </p>
        )}
        <p className="text-xs text-muted">
          {activity?.stats
            .map((s) => `${s.role}: ${s.wins}W ${s.losses}L ${s.voids} void over ${s.rounds}`)
            .join(' · ') || 'No resolved trades yet.'}
        </p>
        {activity?.stats.some((s) => s.replay) && (
          <p className="text-xs text-bad">
            Replay: this record is sample data, not results of real trades or predictions.
          </p>
        )}
      </header>

      {isOwner && <OwnerControls agent={agent} />}

      <Panel title="Trades (every commit, including failures)">
        {history?.intents.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs whitespace-nowrap [&_td]:pr-4 [&_th]:pr-4 [&_th]:pb-3 [&_th]:text-[11px] [&_th]:font-semibold [&_th]:tracking-[1px] [&_th]:text-mute [&_th]:uppercase">
              <thead>
                <tr>
                  <th>Market</th>
                  <th>State</th>
                  <th>Size</th>
                  <th>Entry / SL / TP</th>
                  <th>PnL</th>
                  <th>Commit</th>
                  <th>Fill</th>
                  <th>Exit</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {history.intents.map((i) => {
                  const pnl =
                    i.usdcSpent != null && i.usdcReceived != null
                      ? (i.usdcReceived - i.usdcSpent) / 1e6
                      : null
                  return (
                    <tr key={i.intentId} className="border-t border-hairline">
                      <td className="py-3">{i.roundId}</td>
                      <td title={i.failReason ?? ''}>{i.state}</td>
                      <td>{(i.sizeQuote / 1e6).toFixed(2)}</td>
                      <td>
                        {i.entryRefPrice} / {i.stopPrice} / {i.targetPrice}
                      </td>
                      <td className={pnl == null ? '' : pnl > 0 ? 'text-ok' : 'text-bad'}>
                        {pnl == null ? '—' : pnl.toFixed(4)}
                      </td>
                      <td>
                        <TxLink hash={i.commitTx} />
                      </td>
                      <td>
                        <TxLink hash={i.entryFillTx} />
                      </td>
                      <td>
                        <TxLink hash={i.exitFillTx} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No trades yet.</Empty>
        )}
      </Panel>

      <Panel title="Decisions (0G Private Computer)">
        {activity?.decisions.length ? (
          <ul className="flex flex-col text-xs">
            {activity.decisions.map((d) => (
              <li
                key={d.id}
                className="flex flex-col gap-2 border-b border-hairline py-3 first:pt-0 last:border-0"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-ink">
                    {d.roundId ? `Market ${d.roundId}` : 'Thought'} · {d.kind}
                  </span>
                  <ModelBadge d={d} />
                  <Badge tone={d.accepted ? 'ok' : 'bad'}>
                    {d.accepted ? 'accepted' : `rejected: ${d.rejectReason}`}
                  </Badge>
                </div>
                <span className="font-mono break-all text-mute">request {d.requestId}</span>
                <details>
                  <summary className="cursor-pointer text-mute">model output</summary>
                  <pre className="mt-2 rounded-lg border border-hairline bg-elevated p-3 font-mono whitespace-pre-wrap break-all text-body">
                    {d.rawOutput}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No decisions yet.</Empty>
        )}
      </Panel>
    </div>
  )
}
