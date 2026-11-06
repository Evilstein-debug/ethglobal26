/**
 * Token addresses per chain. Sources and check dates are in VERIFIED.md ("Tokens").
 * Never add an address here without a source there.
 *
 * - USDC is the app's only currency (funding, trade budgets, rewards).
 * - WETH is the only tradable asset (TRADE_ASSETS), so an agent can't fake PnL by trading a
 *   token its owner controls.
 * - On local anvil, USDC and WETH are the deployed MockUSDC / MockWETH (local test only), used
 *   with the local Flash stub.
 */
import type { Address } from 'viem'
import { base } from 'viem/chains'
import { mockUsdcAddress, mockWethAddress } from './generated'
import { LOCAL_CHAIN_ID } from './chains'

export type TokenSymbol = 'USDC' | 'WETH'
export type TokenInfo = { symbol: TokenSymbol; address: Address; decimals: number }

export const USDC_DECIMALS = 6

const BASE_TOKENS: Record<TokenSymbol, TokenInfo> = {
  // Circle's native USDC on Base mainnet.
  USDC: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
  // WETH9 predeploy on Base mainnet.
  WETH: { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
}

/** Assets agents may trade. Validation and the policy engine both enforce this. */
export const TRADE_ASSETS = ['WETH'] as const
export type TradeAsset = (typeof TRADE_ASSETS)[number]

export function tokenOn(chainId: number, symbol: TokenSymbol): TokenInfo | undefined {
  if (chainId === base.id) return BASE_TOKENS[symbol]
  if (chainId === LOCAL_CHAIN_ID) {
    const map = (symbol === 'USDC' ? mockUsdcAddress : mockWethAddress) as Partial<
      Record<number, Address>
    >
    const address = map[chainId]
    return address
      ? { symbol, address, decimals: symbol === 'USDC' ? USDC_DECIMALS : 18 }
      : undefined
  }
  return undefined
}

export function requireToken(chainId: number, symbol: TokenSymbol): TokenInfo {
  const token = tokenOn(chainId, symbol)
  if (!token) throw new Error(`${symbol} has no address on chain ${chainId} (see shared/tokens.ts)`)
  return token
}
