'use client'

import { addressOn } from '@starter/shared/chains'
import { simpleEscrowAddress } from '@starter/shared/generated'
import { ConnectButton } from '@/components/connect-button'
import { CreateDeal } from '@/components/create-deal'
import { Deals } from '@/components/deals'
import { Feed } from '@/components/feed'
import { Panel } from '@/components/ui'
import { targetChain } from '@/lib/env'

const escrow = addressOn(simpleEscrowAddress, targetChain.id)

// The whole app. Replace the escrow panels with your product.
export function App() {
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-4 py-6">
      <header className="flex items-center justify-between border-b border-line pb-4">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-sm font-semibold tracking-tight">eth-starter</span>
          <span className="text-xs text-muted uppercase tracking-widest">{targetChain.name}</span>
        </div>
        <ConnectButton />
      </header>

      {escrow ? (
        <main className="grid gap-px border border-line bg-line md:grid-cols-2">
          <Panel title="New escrow">
            <CreateDeal escrow={escrow} />
          </Panel>
          <Panel title="Your deals">
            <Deals escrow={escrow} />
          </Panel>
          <Panel title="Activity" className="md:col-span-2">
            <Feed />
          </Panel>
        </main>
      ) : (
        <p className="text-sm text-muted">
          SimpleEscrow is not deployed on {targetChain.name}. Run <code>pnpm dev</code> (local) or{' '}
          <code>pnpm deploy:sepolia</code>.
        </p>
      )}
    </div>
  )
}
