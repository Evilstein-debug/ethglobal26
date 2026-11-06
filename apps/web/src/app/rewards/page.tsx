'use client'

import { arenaAbi } from '@starter/shared/generated'
import { useAccount, useReadContract, useReadContracts } from 'wagmi'
import { TxLink } from '@/components/links'
import { TxStatus } from '@/components/tx-status'
import { Badge, Button, Empty, Panel, short } from '@/components/ui'
import { errorText, useApi, useHealth } from '@/lib/api'
import { useTx } from '@/lib/use-tx'

type Award = {
  id: number
  epochId: number
  humanId: `0x${string}`
  ownerWallet: string
  agentId: string
  category: 'trader' | 'predictor'
  rank: number
  amountUsdc: number
  claimTx: string | null
}
type Epoch = {
  id: number
  startsAt: number
  endsAt: number
  budgetUsdc: number
  status: 'open' | 'computed' | 'published'
  publishTx: string | null
  awards: Award[]
}

const time = (ms: number) => new Date(ms).toLocaleString()

function Stat({ label, units }: { label: string; units: bigint | undefined }) {
  return (
    <div>
      <p className="text-xs text-muted uppercase tracking-widest">{label}</p>
      <p className="font-mono text-lg">
        {units === undefined ? '—' : (Number(units) / 1e6).toFixed(2)}
      </p>
    </div>
  )
}

function Pool({ arena }: { arena: `0x${string}` }) {
  const read = { address: arena, abi: arenaAbi } as const
  const { data } = useReadContracts({
    contracts: [
      { ...read, functionName: 'poolBalance' },
      { ...read, functionName: 'availablePool' },
      { ...read, functionName: 'epochCap' },
    ],
    query: { refetchInterval: 10_000 },
  })
  return (
    <Panel title="Reward pool (USDC, read onchain)">
      <div className="flex flex-wrap gap-8">
        <Stat label="Pool balance" units={data?.[0]?.result} />
        <Stat label="Unallocated" units={data?.[1]?.result} />
        <Stat label="Cap per epoch" units={data?.[2]?.result} />
      </div>
    </Panel>
  )
}

/** Paid to the owner wallet of the award's human; the contract rejects everyone else. */
function Claim({ award, arena }: { award: Award; arena: `0x${string}` }) {
  const { state, send, busy } = useTx()
  const { data: claimed } = useReadContract({
    address: arena,
    abi: arenaAbi,
    functionName: 'claimed',
    args: [BigInt(award.epochId), award.humanId],
  })
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span>
          Epoch {award.epochId} · {award.category} #{award.rank} ·{' '}
          <span className="font-mono">{award.amountUsdc?.toFixed(2)} USDC</span>
        </span>
        {claimed ? (
          <span className="flex items-center gap-2">
            <Badge tone="ok">claimed</Badge>
            <TxLink hash={award.claimTx} />
          </span>
        ) : (
          <Button
            disabled={busy || claimed === undefined}
            onClick={() =>
              send({
                address: arena,
                abi: arenaAbi,
                functionName: 'claim',
                args: [BigInt(award.epochId)],
              })
            }
          >
            Claim
          </Button>
        )}
      </div>
      <TxStatus state={state} />
    </div>
  )
}

function MyAwards({ arena }: { arena: `0x${string}` }) {
  const { address } = useAccount()
  const { data, error } = useApi<{ awards: Award[] }>(
    address ? `/api/owners/${address}/awards` : null,
    10_000,
  )
  return (
    <Panel title="My rewards">
      {!address ? (
        <Empty>Connect your owner wallet to see and claim rewards.</Empty>
      ) : error ? (
        <Empty>Could not load rewards: {errorText(error)}</Empty>
      ) : !data ? (
        <Empty>Loading…</Empty>
      ) : data.awards.length ? (
        <div className="flex flex-col gap-3">
          {data.awards.map((a) => (
            <Claim key={a.id} award={a} arena={arena} />
          ))}
        </div>
      ) : (
        <Empty>
          Nothing to claim yet. Top traders and the top predictor earn from each epoch; at most one
          award per human.
        </Empty>
      )}
    </Panel>
  )
}

export default function RewardsPage() {
  const { data: health } = useHealth()
  const { data, error } = useApi<{ epochs: Epoch[] }>('/api/epochs', 10_000)
  const arena = health?.contracts.arena

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold">Rewards</h1>
      {arena && <Pool arena={arena} />}
      {arena && <MyAwards arena={arena} />}
      <Panel title="Epochs">
        {error ? (
          <Empty>Could not load epochs: {errorText(error)}</Empty>
        ) : !data ? (
          <Empty>Loading…</Empty>
        ) : data.epochs.length ? (
          <div className="flex flex-col gap-4">
            {data.epochs.map((e) => (
              <div key={e.id} className="flex flex-col gap-1 border-t border-line pt-2 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">Epoch {e.id}</span>
                  <Badge tone={e.status === 'published' ? 'ok' : 'muted'}>{e.status}</Badge>
                  <span className="text-xs text-muted">
                    {time(e.startsAt)} → {time(e.endsAt)} · budget {e.budgetUsdc?.toFixed(2)} USDC
                  </span>
                  {e.publishTx && <TxLink hash={e.publishTx} label="published" />}
                </p>
                {e.awards.length > 0 ? (
                  <ul className="flex flex-col gap-0.5 text-xs text-muted">
                    {e.awards.map((a) => (
                      <li key={a.id} className="font-mono">
                        {a.category} #{a.rank} · {short(a.ownerWallet)} · {a.amountUsdc?.toFixed(2)}{' '}
                        USDC {a.claimTx ? '· claimed' : ''}
                      </li>
                    ))}
                  </ul>
                ) : (
                  e.status !== 'open' && (
                    <p className="text-xs text-muted">No agent qualified this epoch.</p>
                  )
                )}
              </div>
            ))}
          </div>
        ) : (
          <Empty>No epochs yet. The first one opens with the first round.</Empty>
        )}
      </Panel>
    </div>
  )
}
