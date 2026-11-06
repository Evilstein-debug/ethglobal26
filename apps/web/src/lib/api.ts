'use client'

import { AUTH_MAX_AGE_MS, authHeader, authMessage } from '@starter/shared/auth'
import { useQuery } from '@tanstack/react-query'
import { useAccount, useSignMessage } from 'wagmi'
import { serverUrl } from './env'

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly body: Record<string, unknown>,
  ) {
    super(code)
  }
}

export async function api<T = Record<string, unknown>>(
  path: string,
  opts: { method?: string; body?: unknown; auth?: string } = {},
): Promise<T> {
  const res = await fetch(`${serverUrl}${path}`, {
    method: opts.method ?? (opts.body === undefined ? 'GET' : 'POST'),
    headers: {
      'content-type': 'application/json',
      // A free ngrok tunnel answers browsers with an HTML warning page unless this is set.
      'ngrok-skip-browser-warning': '1',
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new ApiError(res.status, String(body.error ?? `http_${res.status}`), body)
  return body as T
}

/** Read endpoint as a query, optionally polled. */
export function useApi<T>(path: string | null, refetchInterval?: number) {
  return useQuery({
    queryKey: ['api', path],
    queryFn: () => api<T>(path!),
    enabled: Boolean(path),
    refetchInterval,
  })
}

// One signature per wallet, reused until shortly before it expires (server allows 10 min).
const cache = new Map<string, { header: string; issuedAt: number }>()

/** Owner auth: the wallet signs a sign-in message (no gas, no funds) the server verifies. */
export function useOwnerAuth() {
  const { address } = useAccount()
  const { signMessageAsync } = useSignMessage()
  return async () => {
    if (!address) throw new Error('Connect a wallet first')
    const key = address.toLowerCase()
    const hit = cache.get(key)
    if (hit && Date.now() - hit.issuedAt < AUTH_MAX_AGE_MS - 2 * 60_000) return hit.header
    const issuedAt = Date.now()
    const signature = await signMessageAsync({ message: authMessage(address, issuedAt) })
    const header = authHeader(address, issuedAt, signature)
    cache.set(key, { header, issuedAt })
    return header
  }
}

export type Health = {
  ok: boolean
  chainId: number
  humanVerifier: 'world' | 'dev'
  flash: 'flash' | 'local-stub' | 'not_configured'
  livePrice?: number
  llm: { kind: '0g' | 'local-stub'; model: string } | 'not_configured'
  contracts: {
    tradeLog: `0x${string}`
    arena: `0x${string}`
    usdc: `0x${string}`
    weth?: `0x${string}`
  }
}

export const useHealth = () => useApi<Health>('/health', 15_000)

/** ETH amounts: 4 decimals normally, but small gas balances keep two significant digits
 *  (0.0000126 → "0.000013") instead of rounding to zero. */
export function ethAmount(value: number | string | null | undefined) {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n) || n === 0) return '0'
  return n >= 0.0001
    ? n.toFixed(4)
    : new Intl.NumberFormat('en-US', { maximumSignificantDigits: 2 }).format(n)
}

export const usdc = (n: number | null | undefined, digits = 2) =>
  n == null ? '—' : `${(n / 1e6).toFixed(digits)} USDC`

export function errorText(err: unknown) {
  if (err instanceof ApiError) {
    const msg = (err.body.detail as { message?: string } | undefined)?.message
    return msg ?? err.code.replaceAll('_', ' ')
  }
  return err instanceof Error ? err.message : String(err)
}
