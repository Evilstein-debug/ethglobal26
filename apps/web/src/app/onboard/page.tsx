'use client'

import {
  IDKitRequestWidget,
  proofOfHuman,
  type IDKitResult,
  type RpContext,
} from '@worldcoin/idkit'
import { useQueryClient } from '@tanstack/react-query'
import Link from 'next/link'
import { useState } from 'react'
import { useAccount } from 'wagmi'
import { Button, Empty, Field, Panel } from '@/components/ui'
import { api, ApiError, errorText, useApi, useOwnerAuth } from '@/lib/api'

type WorldConfig = {
  method: 'world' | 'dev'
  app_id?: `app_${string}`
  rp_id?: string
  action?: string
  environment?: 'production' | 'staging'
}
type Status =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'done'; registerTx: string }
  | { kind: 'already' }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string }

const WHY = `We only need to know you're one unique person, not who you are. One human = one account, so nobody can farm the reward pool or predict on their own agents with extra accounts. World ID Proof of Human proves exactly that and nothing more.`

function StatusLine({ status }: { status: Status }) {
  switch (status.kind) {
    case 'done':
      return (
        <p className="text-sm text-ok">
          ✓ Verified. You&apos;re registered onchain as a unique human.{' '}
          <Link className="underline" href="/agents">
            Create an agent →
          </Link>
        </p>
      )
    case 'already':
      return (
        <p className="text-sm text-bad">
          This person already has an account. One human, one account: use the wallet you verified
          with first.
        </p>
      )
    case 'cancelled':
      return <p className="text-sm text-muted">Verification cancelled. Nothing was stored.</p>
    case 'error':
      return <p className="text-sm text-bad">{status.message}</p>
    case 'working':
      return <p className="text-sm text-muted">Verifying…</p>
    default:
      return null
  }
}

export default function Onboard() {
  const { address } = useAccount()
  const getAuth = useOwnerAuth()
  const queryClient = useQueryClient()
  const { data: config } = useApi<WorldConfig>('/api/world/config')
  const { data: owner } = useApi<{ verified: boolean }>(address ? `/api/owners/${address}` : null)
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [open, setOpen] = useState(false)
  const [rpContext, setRpContext] = useState<RpContext | null>(null)
  const [devHuman, setDevHuman] = useState('')

  async function submitProof(proof: unknown) {
    setStatus({ kind: 'working' })
    try {
      const res = await api<{ registerTx: string }>('/api/owners/verify', {
        body: { proof },
        auth: await getAuth(),
      })
      setStatus({ kind: 'done', registerTx: res.registerTx })
      await queryClient.invalidateQueries()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'human_already_registered')
        setStatus({ kind: 'already' })
      else if (err instanceof ApiError && err.code === 'verification_cancelled')
        setStatus({ kind: 'cancelled' })
      else setStatus({ kind: 'error', message: errorText(err) })
      throw err
    }
  }

  async function startWorld() {
    setStatus({ kind: 'idle' })
    try {
      await getAuth() // sign in first so the proof can be submitted right after
      const sig = await api<{ sig: string; nonce: string; created_at: number; expires_at: number }>(
        '/api/world/rp-signature',
        { method: 'POST' },
      )
      setRpContext({
        rp_id: config!.rp_id!,
        nonce: sig.nonce,
        created_at: sig.created_at,
        expires_at: sig.expires_at,
        signature: sig.sig,
      })
      setOpen(true)
    } catch (err) {
      setStatus({ kind: 'error', message: errorText(err) })
    }
  }

  if (!address) return <Empty>Connect a wallet to verify.</Empty>
  if (owner?.verified && status.kind !== 'done') {
    return (
      <Panel title="Verified">
        <p className="text-sm text-ok">✓ This wallet belongs to a verified unique human.</p>
        <Link href="/agents" className="text-sm underline">
          Go to your agents →
        </Link>
      </Panel>
    )
  }
  if (!config) return <Empty>Loading…</Empty>

  return (
    <Panel title="Verify you're a unique human">
      <p className="text-sm text-muted">{WHY}</p>
      {config.method === 'world' ? (
        <>
          <Button onClick={startWorld} disabled={status.kind === 'working'}>
            Verify with World ID
          </Button>
          {rpContext && config.app_id && config.action && (
            <IDKitRequestWidget
              open={open}
              onOpenChange={setOpen}
              app_id={config.app_id}
              action={config.action}
              rp_context={rpContext}
              allow_legacy_proofs={true}
              environment={config.environment}
              preset={proofOfHuman({ signal: address.toLowerCase() })}
              handleVerify={async (result: IDKitResult) => {
                await submitProof(result)
              }}
              onSuccess={() => undefined}
              onError={(code) => {
                if (code === 'user_rejected') setStatus({ kind: 'cancelled' })
                else if (code !== 'failed_by_host_app')
                  setStatus({ kind: 'error', message: `World ID: ${code}` })
              }}
            />
          )}
        </>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            submitProof({ devHuman }).catch(() => undefined)
          }}
        >
          <p className="border border-bad p-2 text-xs text-bad">
            LOCAL ANVIL ONLY: the server uses a dev identity check instead of World ID. Any name is
            accepted; the same name twice is &quot;the same human&quot;. Type “cancel” to see the
            cancelled path.
          </p>
          <Field
            label="Dev identity"
            value={devHuman}
            onChange={(e) => setDevHuman(e.target.value)}
            placeholder="e.g. bob"
            required
          />
          <Button type="submit" disabled={status.kind === 'working'}>
            Verify (dev)
          </Button>
        </form>
      )}
      <StatusLine status={status} />
    </Panel>
  )
}
