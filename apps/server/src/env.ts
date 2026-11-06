import { parseChainId } from '@starter/shared/chains'

export const env = {
  chainId: parseChainId(process.env.CHAIN_ID),
  rpcUrl: process.env.RPC_URL || undefined,
  port: Number(process.env.PORT) || 8787,
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim()),
}
