import { getChain, parseChainId, resolveRpcUrl } from '@starter/shared/chains'

// NEXT_PUBLIC_* must be referenced literally so Next can inline them into the bundle.
export const targetChainId = parseChainId(process.env.NEXT_PUBLIC_CHAIN_ID)
export const targetChain = getChain(targetChainId)
export const targetRpcUrl = resolveRpcUrl(targetChain, process.env.NEXT_PUBLIC_RPC_URL)
export const walletConnectProjectId = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || undefined
export const serverUrl = process.env.NEXT_PUBLIC_SERVER_URL || 'http://localhost:8787'
/**
 * Recording mode: hides the simulated-Flash markers and the local dev controls (faucet, price
 * buttons) for a clean demo video. Model and identity stub labels still show, so a run that fell
 * back from 0G or World ID can't be recorded as if it were real.
 */
export const demoMode = process.env.NEXT_PUBLIC_DEMO_MODE === '1'
