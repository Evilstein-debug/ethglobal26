'use client'

import { ConnectButton as RainbowConnect } from '@rainbow-me/rainbowkit'
import { Button } from './ui'

/** RainbowKit's modals with our own square buttons. Handles connect, wrong network, account. */
export function ConnectButton() {
  return (
    <RainbowConnect.Custom>
      {({ account, chain, mounted, openConnectModal, openChainModal, openAccountModal }) => {
        if (!mounted) return <div className="h-10 w-32" aria-hidden />
        if (!account || !chain) return <Button onClick={openConnectModal}>Connect wallet</Button>
        if (chain.unsupported) {
          return (
            <Button onClick={openChainModal} className="bg-bad! text-white!">
              Wrong network
            </Button>
          )
        }
        return (
          <Button variant="outline" onClick={openAccountModal} className="font-mono">
            {account.displayName}
            {account.displayBalance ? ` · ${account.displayBalance}` : ''}
          </Button>
        )
      }}
    </RainbowConnect.Custom>
  )
}
