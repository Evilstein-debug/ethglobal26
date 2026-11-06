import { getChain, isLocalChain, resolveRpcUrl } from '@starter/shared/chains'
import { createPublicClient, http } from 'viem'
import { env } from './env'

export const chain = getChain(env.chainId)
export const rpcUrl = resolveRpcUrl(chain, env.rpcUrl)
export const publicClient = createPublicClient({
  chain,
  transport: http(rpcUrl),
  // Local anvil mines instantly; poll fast there.
  pollingInterval: isLocalChain(chain.id) ? 200 : undefined,
})
