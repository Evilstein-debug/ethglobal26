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
    dailyCap: string
    predictionsPerDay: number
    tokenAllowlist: string[]
    paused: boolean
  }
  balances: { usdc: string; eth: string; weth?: string } | null
  reservedUsdc: string
}
