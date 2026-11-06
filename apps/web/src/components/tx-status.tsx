'use client'

import { explorerTxUrl, LOCAL_CHAIN_ID } from '@starter/shared/chains'
import { useEffect, useState } from 'react'
import { targetChain } from '@/lib/env'
import type { TxState } from '@/lib/use-tx'
import { short } from './ui'

const LABEL = {
  idle: '',
  simulating: 'Simulating…',
  signing: 'Confirm in your wallet…',
  pending: 'Pending…',
  confirmed: 'Confirmed',
  failed: 'Failed',
}

/** Anvil mines at once, so a long wait means the wallet is counting from an older local chain. */
function useStuckOnLocalChain(state: TxState) {
  const [stuck, setStuck] = useState(false)
  const pending = state.status === 'pending' && targetChain.id === LOCAL_CHAIN_ID
  useEffect(() => {
    if (!pending) return setStuck(false)
    const timer = setTimeout(() => setStuck(true), 10_000)
    return () => clearTimeout(timer)
  }, [pending])
  return stuck
}

export function TxStatus({ state }: { state: TxState }) {
  const stuck = useStuckOnLocalChain(state)
  if (state.status === 'idle') return null
  const hash = 'hash' in state ? state.hash : undefined
  const url = hash && explorerTxUrl(targetChain, hash)
  const color =
    state.status === 'confirmed' ? 'text-ok' : state.status === 'failed' ? 'text-bad' : 'text-muted'

  return (
    <p className={`flex flex-wrap gap-x-2 text-xs ${color}`} role="status">
      <span>{LABEL[state.status]}</span>
      {state.status === 'failed' && <span className="break-all">{state.error}</span>}
      {hash &&
        (url ? (
          <a href={url} target="_blank" rel="noreferrer" className="font-mono underline">
            {short(hash)} ↗
          </a>
        ) : (
          <span className="font-mono">{short(hash)}</span>
        ))}
      {stuck && (
        <span>
          Stuck: your wallet is still counting transactions from an older local chain. In MetaMask,
          go to Settings → Advanced → Clear activity tab data, then send again.
        </span>
      )}
    </p>
  )
}
