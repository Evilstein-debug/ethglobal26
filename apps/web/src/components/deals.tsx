'use client'

import { simpleEscrowAbi } from '@starter/shared/generated'
import { formatEther, isAddressEqual, type Address } from 'viem'
import { useAccount, useBlock, useReadContract, useReadContracts } from 'wagmi'
import { useTx } from '@/lib/use-tx'
import { TxStatus } from './tx-status'
import { Button, short } from './ui'

const STATUS = ['—', 'Open', 'Released', 'Refunded'] as const
const LOOKBACK = 50n // only the most recent deals; index events on the server for more

type Deal = {
  id: bigint
  payer: Address
  payee: Address
  amount: bigint
  deadline: bigint
  status: number
}

export function Deals({ escrow }: { escrow: Address }) {
  const { address } = useAccount()
  // Chain time, not wall-clock time, decides whether the deadline has passed.
  const { data: block } = useBlock({ watch: true })
  const { data: nextId = 0n } = useReadContract({
    address: escrow,
    abi: simpleEscrowAbi,
    functionName: 'nextId',
  })

  const first = nextId > LOOKBACK ? nextId - LOOKBACK : 0n
  const ids = Array.from({ length: Number(nextId - first) }, (_, i) => first + BigInt(i))
  const { data } = useReadContracts({
    allowFailure: false,
    contracts: ids.map(
      (id) =>
        ({ address: escrow, abi: simpleEscrowAbi, functionName: 'deals', args: [id] }) as const,
    ),
    query: { enabled: Boolean(address) && ids.length > 0 },
  })

  if (!address) return <p className="text-sm text-muted">Connect a wallet to see your deals.</p>

  const deals: Deal[] = (data ?? [])
    .map(([payer, payee, amount, deadline, status], i) => ({
      id: ids[i]!,
      payer,
      payee,
      amount,
      deadline,
      status,
    }))
    .filter((d) => isAddressEqual(d.payer, address) || isAddressEqual(d.payee, address))
    .reverse()

  if (deals.length === 0) return <p className="text-sm text-muted">No deals yet.</p>

  return (
    <ul className="flex flex-col divide-y divide-line border-y border-line">
      {deals.map((deal) => (
        <DealRow
          key={deal.id.toString()}
          deal={deal}
          escrow={escrow}
          me={address}
          now={block?.timestamp ?? 0n}
        />
      ))}
    </ul>
  )
}

function DealRow({
  deal,
  escrow,
  me,
  now,
}: {
  deal: Deal
  escrow: Address
  me: Address
  now: bigint
}) {
  const { state, send, busy } = useTx()
  const isPayer = isAddressEqual(deal.payer, me)
  const open = deal.status === 1
  const refundable = now >= deal.deadline
  const call = (functionName: 'release' | 'refund') =>
    send({ address: escrow, abi: simpleEscrowAbi, functionName, args: [deal.id] })

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-baseline justify-between gap-4 text-sm">
        <span className="font-mono">
          #{deal.id.toString()} · {formatEther(deal.amount)} ETH {isPayer ? '→' : '←'}{' '}
          {short(isPayer ? deal.payee : deal.payer)}
        </span>
        <span className={`text-xs uppercase tracking-widest ${open ? 'text-fg' : 'text-muted'}`}>
          {STATUS[deal.status]}
        </span>
      </div>
      {open && (
        <p className="text-xs text-muted">
          Refundable after {new Date(Number(deal.deadline) * 1000).toLocaleString()}
        </p>
      )}
      {open && isPayer && (
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => call('release')}>
            Release
          </Button>
          <Button variant="outline" disabled={busy || !refundable} onClick={() => call('refund')}>
            Refund
          </Button>
        </div>
      )}
      <TxStatus state={state} />
    </li>
  )
}
