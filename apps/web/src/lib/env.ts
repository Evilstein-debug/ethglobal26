import { getChain, parseChainId, resolveRpcUrl } from '@starter/shared/chains'

// NEXT_PUBLIC_* must be referenced literally so Next can inline them into the bundle.
export const targetChainId = parseChainId(process.env.NEXT_PUBLIC_CHAIN_ID)
export const targetChain = getChain(targetChainId)
export const targetRpcUrl = resolveRpcUrl(targetChain, process.env.NEXT_PUBLIC_RPC_URL)
export const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || undefined
export const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:8787'
