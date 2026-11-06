/**
 * Supported chains. Chain metadata (id, default RPC, explorer) comes from viem's
 * maintained definitions, so nothing here is hand-typed.
 *
 * To add a chain: import it from 'viem/chains' (or build one with `defineChain`),
 * add it to SUPPORTED_CHAINS, deploy, and run `pnpm codegen`.
 */
import type { Chain, Hash, Address } from 'viem'
import { anvil, sepolia } from 'viem/chains'

export const SUPPORTED_CHAINS = [anvil, sepolia] as const satisfies readonly Chain[]

export type SupportedChain = (typeof SUPPORTED_CHAINS)[number]
export type SupportedChainId = SupportedChain['id']

export const LOCAL_CHAIN_ID = anvil.id
export const DEFAULT_CHAIN_ID: SupportedChainId = anvil.id

export function isSupportedChainId(id: number): id is SupportedChainId {
  return SUPPORTED_CHAINS.some((c) => c.id === id)
}

export function getChain(id: number): SupportedChain {
  const chain = SUPPORTED_CHAINS.find((c) => c.id === id)
  if (!chain) {
    const ids = SUPPORTED_CHAINS.map((c) => `${c.id} (${c.name})`).join(', ')
    throw new Error(
      `Unsupported chain ID ${id}. Supported: ${ids}. Add it in packages/shared/src/chains.ts`,
    )
  }
  return chain
}

/** Parse a chain ID from env (e.g. NEXT_PUBLIC_CHAIN_ID). Unset → local anvil. */
export function parseChainId(value: string | undefined): SupportedChainId {
  if (!value) return DEFAULT_CHAIN_ID
  const id = Number(value)
  if (!Number.isInteger(id) || !isSupportedChainId(id)) getChain(id) // throws a helpful error
  return id as SupportedChainId
}

export function isLocalChain(id: number): boolean {
  return id === LOCAL_CHAIN_ID
}

/** An explicit RPC URL from env wins; otherwise viem's default public RPC for the chain. */
export function resolveRpcUrl(chain: Chain, override?: string): string {
  return override || chain.rpcUrls.default.http[0]!
}

export function explorerTxUrl(chain: Chain, hash: Hash): string | undefined {
  const base = chain.blockExplorers?.default.url
  return base ? `${base}/tx/${hash}` : undefined
}

export function explorerAddressUrl(chain: Chain, address: Address): string | undefined {
  const base = chain.blockExplorers?.default.url
  return base ? `${base}/address/${address}` : undefined
}

/** Look up a generated `xxxAddress` map for a chain; undefined if not deployed there. */
export function addressOn(addresses: Partial<Record<number, Address>>, chainId: number) {
  return addresses[chainId]
}
