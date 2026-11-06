import { getDefaultConfig } from '@rainbow-me/rainbowkit'
import { isLocalChain } from '@starter/shared/chains'
import type { Chain, Transport } from 'viem'
import { createConfig, http } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { targetChain, targetRpcUrl, walletConnectProjectId } from './env'

// One active chain per deployment (NEXT_PUBLIC_CHAIN_ID). A wallet on any other network is
// "wrong network", and the connect button offers to switch.
const chains: [Chain] = [targetChain]
const transports: Record<number, Transport> = { [targetChain.id]: http(targetRpcUrl) }
// Local anvil mines instantly; poll receipts fast there.
const pollingInterval = isLocalChain(targetChain.id) ? 500 : undefined

function makeConfig() {
  if (walletConnectProjectId) {
    return getDefaultConfig({
      appName: 'eth-starter',
      projectId: walletConnectProjectId,
      chains,
      transports,
      ssr: true,
      pollingInterval,
    })
  }
  if (typeof window !== 'undefined') {
    console.info(
      '[wallet] NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID is not set: only browser (injected) wallets ' +
        'are available. Get a free project ID at https://dashboard.reown.com to enable WalletConnect.',
    )
  }
  // Browser wallets announced via EIP-6963 are discovered automatically; injected() is the fallback.
  return createConfig({ chains, transports, connectors: [injected()], ssr: true, pollingInterval })
}

export const wagmiConfig = makeConfig()
