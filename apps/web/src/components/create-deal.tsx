'use client'

import { simpleEscrowAbi } from '@starter/shared/generated'
import { useState } from 'react'
import { isAddress, parseEther, type Address } from 'viem'
import { useAccount } from 'wagmi'
import { useTx } from '@/lib/use-tx'
import { TxStatus } from './tx-status'
import { Button, Field } from './ui'

const DURATIONS = [
  ['1h', 3_600],
  ['1d', 86_400],
  ['7d', 604_800],
] as const

function toWei(value: string) {
  try {
    const wei = parseEther(value)
    return wei > 0n ? wei : undefined
  } catch {
    return undefined
  }
}

export function CreateDeal({ escrow }: { escrow: Address }) {
  const { isConnected } = useAccount()
  const { state, send, busy } = useTx()
  const [payee, setPayee] = useState('')
  const [amount, setAmount] = useState('0.1')
  const [duration, setDuration] = useState<number>(DURATIONS[1][1])

  const value = toWei(amount)
  const valid = isAddress(payee) && value !== undefined

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault()
        if (!valid) return
        void send({
          address: escrow,
          abi: simpleEscrowAbi,
          functionName: 'create',
          args: [payee, BigInt(Math.floor(Date.now() / 1000) + duration)],
          value,
        })
      }}
    >
      <Field
        label="Payee"
        placeholder="0x…"
        value={payee}
        onChange={(e) => setPayee(e.target.value)}
      />
      <Field
        label="Amount (ETH)"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted uppercase tracking-widest">Refundable after</span>
        <div className="grid grid-cols-3 border border-line">
          {DURATIONS.map(([label, seconds]) => (
            <button
              key={label}
              type="button"
              onClick={() => setDuration(seconds)}
              className={`h-10 text-sm ${duration === seconds ? 'bg-fg text-bg' : 'hover:bg-line'}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>
      <Button type="submit" disabled={!isConnected || !valid || busy}>
        {isConnected ? 'Lock ETH' : 'Connect a wallet to start'}
      </Button>
      <TxStatus state={state} />
    </form>
  )
}
