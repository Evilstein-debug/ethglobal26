export type AgentView = {
  id: string
  name: string
  mode: 'trade' | 'predict' | 'both'
  address: `0x${string}`
  owner: `0x${string}`
  status: 'active' | 'paused'
  registerTx: string | null
  policy?: {
    perTradeCap: string
    roundTradeCap: string
    dailyCap: string
    predictionsPerRound: number
    tokenAllowlist: string[]
    paused: boolean
  }
  balances: { usdc: string; eth: string; weth?: string } | null
  reservedUsdc: string
}
