import { getChain, isLocalChain, resolveRpcUrl } from '@starter/shared/chains'
import { createPublicClient, http } from 'viem'
import { env } from '../env'

export const chain = getChain(env.chainId)
export const rpcUrl = resolveRpcUrl(chain, env.rpcUrl)
// Local anvil mines instantly; poll fast there.
export const pollingInterval = isLocalChain(chain.id) ? 200 : undefined
export const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval })
