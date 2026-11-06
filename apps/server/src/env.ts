/**
 * Server configuration from the environment. Local anvil runs with zero configuration: missing
 * secrets fall back to clearly-labeled LOCAL-ONLY defaults. On any real chain every secret is
 * required and the dev fallbacks are refused.
 */
import { resolve } from 'node:path'
import { isLocalChain, parseChainId } from '@starter/shared/chains'
import { isAddress, type Address, type Hex } from 'viem'

const chainId = parseChainId(process.env.CHAIN_ID)
const local = isLocalChain(chainId)

/** LOCAL ONLY. Public anvil dev account #0 (from the documented test mnemonic). */
const ANVIL_ACCOUNT_0_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
/** LOCAL ONLY. A fixed, public master key so local agent keys survive restarts. */
const LOCAL_DEV_MASTER_KEY = 'de'.repeat(32)

function secret(name: string, localDefault: string): string {
  const value = process.env[name]
  if (value) return value
  if (local) return localDefault
  throw new Error(`${name} is required on chain ${chainId} (see apps/server/.env.example)`)
}

function addressList(name: string): Address[] {
  const values = (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  for (const v of values) if (!isAddress(v)) throw new Error(`${name}: not an address: ${v}`)
  return values as Address[]
}

export const env = {
  chainId,
  isLocal: local,
  rpcUrl: process.env.RPC_URL || undefined,
  port: Number(process.env.PORT) || 8787,
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:3000').split(',').map((s) => s.trim()),
  /**
   * postgres://… (Neon in production) or a local PGlite directory.
   * Default: apps/server/data/pglite-<chainId> (gitignored), one database per chain.
   */
  databaseUrl:
    process.env.DATABASE_URL || resolve(import.meta.dirname, `../data/pglite-${chainId}`),
  masterKey: secret('MASTER_KEY', LOCAL_DEV_MASTER_KEY),
  operatorKey: secret('OPERATOR_PRIVATE_KEY', ANVIL_ACCOUNT_0_KEY) as Hex,
  flash: {
    apiKey: process.env.FLASH_API_KEY || undefined,
    baseUrl: process.env.FLASH_API_BASE_URL || 'https://flash.definitive.fi/v1',
    integratorFeeBps: process.env.FLASH_INTEGRATOR_FEE_BPS || '0',
    /** From a real quote's evm.approveTx spender (scripts/flash-inspect.ts). */
    approvalSpenders: addressList('FLASH_APPROVAL_SPENDERS'),
    /** From a real quote's orderTypedData domain.verifyingContract. */
    typedDataContracts: addressList('FLASH_TYPED_DATA_CONTRACTS'),
    /** Optional ERC-8021 builder code (base.dev) attached to order submits. */
    attributionCode: process.env.FLASH_ATTRIBUTION_CODE || undefined,
  },
  /**
   * Hand-written trades (no 0G decision) for smoke-testing the Flash pipeline. Default: only on
   * local anvil. Set to "true" on Base for the one-off first-trade check, then turn it off.
   */
  allowManualTrades: process.env.ALLOW_MANUAL_TRADES
    ? process.env.ALLOW_MANUAL_TRADES === 'true'
    : local,
  /**
   * How owners prove they're human. 'world' verifies IDKit proofs with World (Phase 6).
   * 'dev' accepts a made-up identity and is refused anywhere but local anvil.
   */
  humanVerifier: (process.env.HUMAN_VERIFIER || (local ? 'dev' : 'world')) as 'world' | 'dev',
}

if (env.humanVerifier === 'dev' && !local) {
  throw new Error('HUMAN_VERIFIER=dev is only allowed on local anvil')
}
