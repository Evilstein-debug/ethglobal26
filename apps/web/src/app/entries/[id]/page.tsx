'use client'

import { verifyEntry, type EntryBundle, type VerifyStatus } from '@starter/shared/verify'
import { useQuery } from '@tanstack/react-query'
import Link from 'next/link'
import { useParams } from 'next/navigation'
import type { PublicClient } from 'viem'
import { usePublicClient } from 'wagmi'
import { ModelBadge, TxLink } from '@/components/links'
import { Badge, Empty, Panel, short } from '@/components/ui'
import { errorText, useApi } from '@/lib/api'
import { targetChain } from '@/lib/env'

type Bundle = EntryBundle & { chainId: number }

const pct = (bps: number | null | undefined) => (bps == null ? '—' : `${(bps / 100).toFixed(2)}%`)
const usdc = (units: number | null) => (units == null ? '—' : (units / 1e6).toFixed(6))

const MARK: Record<VerifyStatus, { icon: string; color: string }> = {
  pass: { icon: '✓', color: 'text-ok' },
  fail: { icon: '✗', color: 'text-bad' },
  skip: { icon: '–', color: 'text-muted' },
}

/** Runs in this browser against the chain; the server only supplies the claims being checked. */
function Checklist({ bundle }: { bundle: Bundle }) {
  const client = usePublicClient({ chainId: targetChain.id })
  const { data, error, isFetching } = useQuery({
    queryKey: ['verify', bundle],
    enabled: Boolean(client),
    queryFn: () =>
      verifyEntry(bundle, client as unknown as PublicClient, { chainId: bundle.chainId }),
  })
  return (
    <Panel title="Verification">
      <p className="text-xs text-muted">
        Checked live in your browser against {targetChain.name}: logs, receipts and contract state,
        with hashes and PnL recomputed here. A dash means the step can&apos;t run yet or has nothing
        real to check. Re-run it yourself with{' '}
        <code className="font-mono">pnpm verify {bundle.entry.id}</code>.
      </p>
      {error ? <p className="text-sm text-bad">Could not run checks: {errorText(error)}</p> : null}
      {!data ? (
        <Empty>{isFetching ? 'Checking…' : 'Waiting for a chain connection…'}</Empty>
      ) : (
        <ul className="flex flex-col gap-2 text-sm">
          {data.steps.map((s) => (
            <li key={s.id} className="flex gap-2">
              <span className={`font-mono ${MARK[s.status].color}`}>{MARK[s.status].icon}</span>
              <span className="min-w-0">
                {s.label}
                <span className="block break-words text-xs text-muted">{s.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}

export default function EntryPage() {
  const { id } = useParams<{ id: string }>()
  const { data, error } = useApi<Bundle>(`/api/entries/${id}`, 5000)
  if (error) return <Empty>Could not load this entry: {errorText(error)}</Empty>
  if (!data) return <Empty>Loading…</Empty>
  const { entry, trader, intents, predictions, decisions } = data
  const decisionOf = (decisionId: string | null) => decisions.find((d) => d.id === decisionId)

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-xl font-semibold">
          Will{' '}
          <Link href={`/agents/${trader.id}`} className="underline">
            {trader.name}
          </Link>{' '}
          end round {entry.roundId} in profit?
        </h1>
        <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-muted">
          Entry #{entry.onchainEntryId ?? entry.id}
          <Badge tone={entry.outcome === 'YES' ? 'ok' : entry.outcome === 'NO' ? 'bad' : 'muted'}>
            {entry.outcome.toLowerCase()}
            {entry.outcome === 'YES' || entry.outcome === 'NO' ? ` · ${pct(entry.pnlBps)}` : ''}
            {entry.voidReason ? ` · ${entry.voidReason.replaceAll('_', ' ')}` : ''}
          </Badge>
          <span>
            opened <TxLink hash={entry.openTx} />
          </span>
          <span>
            locked <TxLink hash={data.round.lockTx} />
          </span>
          <span>
            resolved <TxLink hash={entry.resolveTx} />
          </span>
        </p>
      </div>

      <Checklist bundle={data} />

      <Panel title="Trades">
        {intents.length ? (
          <div className="flex flex-col gap-3">
            {intents.map((i) => (
              <div
                key={i.intentId}
                className="flex flex-col gap-1 border-t border-line pt-2 text-sm"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={i.state === 'FAILED' ? 'bad' : 'muted'}>{i.state}</Badge>
                  <span className="font-mono text-xs">
                    target {i.targetPrice} · stop {i.stopPrice} · ref {i.entryRefPrice}
                  </span>
                  {decisionOf(i.decisionId) && <ModelBadge d={decisionOf(i.decisionId)!} />}
                </div>
                {i.failReason && <p className="break-words text-xs text-bad">{i.failReason}</p>}
                <p className="flex flex-wrap gap-x-4 font-mono text-xs text-muted">
                  <span>spent {usdc(i.usdcSpent)}</span>
                  <span>received {usdc(i.usdcReceived)}</span>
                  <span>
                    commit <TxLink hash={i.commitTx} />
                  </span>
                  <span>
                    record <TxLink hash={i.recordTx} />
                  </span>
                  <span>
                    entry fill <TxLink hash={i.entryFillTx} />
                  </span>
                  <span>
                    exit fill <TxLink hash={i.exitFillTx} />
                  </span>
                </p>
              </div>
            ))}
          </div>
        ) : (
          <Empty>No trades committed.</Empty>
        )}
      </Panel>

      <Panel title="Predictions">
        {predictions.length ? (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap text-left text-sm [&_td]:pr-4 [&_th]:pr-4">
              <thead className="text-xs text-muted">
                <tr>
                  <th className="py-1 font-normal">Predictor</th>
                  <th className="font-normal">Call</th>
                  <th className="font-normal">P(YES)</th>
                  <th className="font-normal">Brier</th>
                  <th className="font-normal">Model</th>
                  <th className="font-normal">Tx</th>
                </tr>
              </thead>
              <tbody>
                {predictions.map((p) => {
                  const d = decisionOf(p.decisionId)
                  return (
                    <tr key={p.predictionId} className="border-t border-line">
                      <td className="py-1.5">
                        <span className="font-mono text-xs">{short(p.predictorAddress)}</span>
                      </td>
                      <td>{p.side}</td>
                      <td className="font-mono">{pct(p.probYesBps)}</td>
                      <td className="font-mono">{p.brier?.toFixed(3) ?? '—'}</td>
                      <td>{d ? <ModelBadge d={d} /> : <Badge>{p.predictorKind}</Badge>}</td>
                      <td>
                        <TxLink hash={p.predictTx} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No predictions on this entry.</Empty>
        )}
      </Panel>

      <Panel title="0G decisions">
        {decisions.length ? (
          <ul className="flex flex-col gap-2 text-sm">
            {decisions.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center gap-2">
                <Badge>{d.kind}</Badge>
                <ModelBadge d={d} />
                <Badge tone={d.accepted ? 'ok' : 'bad'}>
                  {d.accepted ? 'accepted' : (d.rejectReason ?? 'rejected')}
                </Badge>
                <span className="break-all font-mono text-xs text-muted">{d.requestId}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No decisions recorded.</Empty>
        )}
      </Panel>
    </div>
  )
}
