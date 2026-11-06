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

/** What the entry endpoint adds to a trade: how it was entered, and what Flash itself reports. */
type TradeExtras = {
  entryStyle?: 'market' | 'twap' | 'limit'
  limitPrice?: string | null
  twapBuckets?: number | null
  twapDurationSec?: number | null
  quoteFirstOut?: string | null
  quoteFinalOut?: string | null
  quoteRevisions?: number | null
  flashNote?: string | null
}

type ReceiptOrder = {
  role: 'entry' | 'bracket' | 'close'
  orderId: string
  type: string
  status: string
  closeReason: string | null
  tranches: { done: number; total: number } | null
  legs: { triggerType: string; priceUsd: string | null }[]
  fills: { at: string; priceUsd: string; tx: string; usdc: string; weth: string; feeUsd: string }[]
  usdc: string | null
}
type PnL = { spent: number; received: number; pnl: number }
type Receipt =
  | { available: false; reason: string }
  | {
      available: true
      source: 'flash' | 'local-stub'
      orders: ReceiptOrder[]
      flash: PnL | null
      ours: PnL | null
      matches: boolean | null
    }

type Bundle = EntryBundle & { chainId: number; receipts?: Record<string, Receipt> }

const pct = (bps: number | null | undefined) => (bps == null ? '—' : `${(bps / 100).toFixed(2)}%`)
const usdc = (units: number | null) => (units == null ? '—' : (units / 1e6).toFixed(6))

const MARK: Record<VerifyStatus, { icon: string; color: string }> = {
  pass: { icon: '✓', color: 'text-ok' },
  fail: { icon: '✗', color: 'text-bad' },
  skip: { icon: '–', color: 'text-muted' },
}

const ROLE: Record<ReceiptOrder['role'], string> = {
  entry: 'Entry',
  bracket: 'Bracket exit',
  close: 'Time-limit sale',
}

/** Flash's own report of the orders, next to the PnL we resolved from. A mismatch is shown. */
function FlashReceipt({ receipt }: { receipt: Receipt | undefined }) {
  if (!receipt) return null
  if (!receipt.available)
    return <p className="text-xs text-muted">Flash receipt unavailable: {receipt.reason}</p>
  const row = (label: string, p: PnL | null) =>
    p ? (
      <tr className="border-t border-line">
        <td className="py-1 pr-4">{label}</td>
        <td className="pr-4 font-mono">{usdc(p.spent)}</td>
        <td className="pr-4 font-mono">{usdc(p.received)}</td>
        <td className="font-mono">{usdc(p.pnl)}</td>
      </tr>
    ) : null
  return (
    <div className="flex flex-col gap-2 rounded border border-line p-2">
      <p className="flex flex-wrap items-center gap-2 text-xs font-semibold">
        Flash receipt
        {receipt.source === 'local-stub' && <Badge>local stub, not Flash</Badge>}
        {receipt.matches === true && <Badge tone="ok">matches our PnL</Badge>}
        {receipt.matches === false && <Badge tone="bad">does not match our PnL</Badge>}
      </p>
      <ul className="flex flex-col gap-2 text-xs">
        {receipt.orders.map((o) => (
          <li key={o.orderId} className="flex flex-col gap-0.5">
            <span className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{ROLE[o.role]}</span>
              <Badge>{o.type}</Badge>
              <Badge tone={o.status === 'filled' ? 'ok' : 'muted'}>{o.status}</Badge>
              {o.tranches && (
                <span>
                  tranche {o.tranches.done} of {o.tranches.total}
                </span>
              )}
              {o.closeReason && <span className="text-muted">{o.closeReason}</span>}
            </span>
            {o.legs.length > 0 && (
              <span className="font-mono text-muted">
                {o.legs.map((l) => `${l.triggerType} ${l.priceUsd ?? '—'}`).join(' · ')}
              </span>
            )}
            {o.fills.map((f) => (
              <span key={f.tx} className="flex flex-wrap gap-x-3 font-mono text-muted">
                <span>fill @ {Number(f.priceUsd).toFixed(2)}</span>
                <span>{f.usdc} USDC</span>
                <span>fee ${Number(f.feeUsd).toFixed(4)}</span>
                <TxLink hash={f.tx} />
              </span>
            ))}
          </li>
        ))}
      </ul>
      {receipt.flash && (
        <table className="text-left text-xs">
          <thead className="text-muted">
            <tr>
              <th className="pr-4 font-normal">USDC</th>
              <th className="pr-4 font-normal">spent</th>
              <th className="pr-4 font-normal">received</th>
              <th className="font-normal">PnL</th>
            </tr>
          </thead>
          <tbody>
            {row('Per Flash', receipt.flash)}
            {row('Per us', receipt.ours)}
          </tbody>
        </table>
      )}
    </div>
  )
}

/** How the entry was built: a TWAP's tranches, and what the quote did while we listened. */
function EntryNotes({ i, entryRef }: { i: TradeExtras; entryRef: string }) {
  const bits: string[] = []
  if (i.entryStyle === 'twap' && i.twapBuckets && i.twapDurationSec)
    bits.push(
      `TWAP: ${i.twapBuckets} tranches over ${Math.round(i.twapDurationSec / 60)} min, which predictors could trim`,
    )
  if (i.entryStyle === 'limit' && i.limitPrice)
    bits.push(
      `Limit entry: rested at ${i.limitPrice} and opened the market only when it filled (market ${entryRef})`,
    )
  if ((i.quoteRevisions ?? 0) > 1 && i.quoteFirstOut && i.quoteFinalOut) {
    const first = Number(i.quoteFirstOut)
    const move = first > 0 ? ((Number(i.quoteFinalOut) - first) / first) * 100 : 0
    bits.push(
      `Quote stream: ${i.quoteRevisions} quotes, signed the newest (${move >= 0 ? '+' : ''}${move.toFixed(3)}% WETH vs the first)`,
    )
  }
  if (!bits.length && !i.flashNote) return null
  return (
    <div className="flex flex-col gap-0.5 text-xs">
      {bits.map((b) => (
        <span key={b} className="text-muted">
          {b}
        </span>
      ))}
      {i.flashNote && <span className="text-bad">{i.flashNote}</span>}
    </div>
  )
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
          </Link>
          &apos;s trade make money?
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
                <EntryNotes i={i as typeof i & TradeExtras} entryRef={i.entryRefPrice} />
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
                <FlashReceipt receipt={data.receipts?.[i.intentId]} />
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
