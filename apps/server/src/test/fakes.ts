/**
 * Test doubles for the chain. Signature checks use viem's local verifyMessage (real ECDSA);
 * balances and Arena writes are in-memory. Real-chain behaviour is covered by e2e on anvil.
 */
import type { AddressInfo } from 'node:net'
import { after } from 'node:test'
import { authHeader, authMessage } from '@starter/shared/auth'
import { verifyMessage, type Address, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import { createApp } from '../app'
import { devHumanVerifier } from '../auth/human'
import type { ArenaOps } from '../chain/operator'
import { DEFAULT_BRAIN, type AppContext } from '../context'
import type { Db } from '../db'
import { KeyBox } from '../wallets/keybox'

export const contracts = {
  tradeLog: '0x00000000000000000000000000000000000000a1' as Address,
  arena: '0x00000000000000000000000000000000000000a2' as Address,
  usdc: '0x00000000000000000000000000000000000000a3' as Address,
}

export function fakeChain() {
  const usdcBalances = new Map<string, bigint>()
  const arenaCalls: { fn: string; args: unknown[] }[] = []
  let tx = 0
  const hash = () => `0x${(++tx).toString(16).padStart(64, '0')}` as Hex
  const publicClient = {
    verifyMessage: (args: { address: Address; message: string; signature: Hex }) =>
      verifyMessage(args),
    readContract: async ({ args }: { args: [Address] }) =>
      usdcBalances.get(args[0].toLowerCase()) ?? 0n,
    getBalance: async () => 0n,
    getBlockNumber: async () => 1n,
    waitForTransactionReceipt: async ({ hash: h }: { hash: Hex }) => ({
      status: 'success',
      transactionHash: h,
    }),
  } as unknown as PublicClient
  const record =
    (fn: string) =>
    async (...args: unknown[]) => {
      arenaCalls.push({ fn, args })
      return hash()
    }
  const arena = {
    address: contracts.arena,
    registerOwner: record('registerOwner'),
    registerAgent: record('registerAgent'),
  } as unknown as ArenaOps
  return { publicClient, arena, arenaCalls, usdcBalances }
}

export async function startApi(db: Db, overrides: Partial<AppContext> = {}) {
  const chain = fakeChain()
  const ctx: AppContext = {
    db,
    chain: anvil,
    rpcUrl: 'http://127.0.0.1:1',
    publicClient: chain.publicClient,
    contracts,
    arena: chain.arena,
    keyBox: new KeyBox('cd'.repeat(32)),
    humanVerifier: devHumanVerifier,
    allowManualTrades: true,
    brain: DEFAULT_BRAIN,
    now: Date.now,
    ...overrides,
  }
  const server = createApp(ctx).listen(0)
  after(() => server.close())
  await new Promise((r) => server.once('listening', r))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { ctx, base, ...chain }
}

export function user(seed: number) {
  const account = privateKeyToAccount(`0x${seed.toString(16).padStart(64, '0')}`)
  return {
    address: account.address,
    async auth(issuedAt = Date.now()) {
      const signature = await account.signMessage({
        message: authMessage(account.address, issuedAt),
      })
      return authHeader(account.address, issuedAt, signature)
    },
  }
}

export async function call(
  base: string,
  method: string,
  path: string,
  opts: { auth?: string; body?: unknown } = {},
) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
