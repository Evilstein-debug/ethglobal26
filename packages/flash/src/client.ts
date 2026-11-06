/**
 * Flash REST client (https://flash.definitive.fi/v1). Auth: `x-definitive-api-key`.
 * 429s and 5xx are retried with backoff; every other error throws FlashApiError carrying the
 * API's `{ error: { code, message } }`.
 */
import { cancelMessage } from './cancel'
import type {
  FlashApi,
  FlashAsset,
  FlashChain,
  GetOrderResponse,
  QuoteRequest,
  QuoteResponse,
  SubmitOrderRequest,
  SubmitOrderResponse,
} from './types'

export class FlashApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(`Flash ${status} ${code}: ${message}`)
    this.name = 'FlashApiError'
  }
}

export type FlashClientOptions = {
  apiKey: string
  baseUrl?: string
  fetch?: typeof fetch
  maxRetries?: number
  timeoutMs?: number
  /** Base backoff in ms (doubles per retry). */
  backoffMs?: number
}

export class FlashClient implements FlashApi {
  readonly kind = 'flash' as const
  readonly #opts: Required<Omit<FlashClientOptions, 'fetch'>> & { fetch: typeof fetch }

  constructor(opts: FlashClientOptions) {
    if (!opts.apiKey) throw new Error('FlashClient: apiKey is required')
    this.#opts = {
      baseUrl: 'https://flash.definitive.fi/v1',
      maxRetries: 3,
      timeoutMs: 20_000,
      backoffMs: 500,
      fetch: globalThis.fetch,
      ...opts,
    }
  }

  async #request<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const { baseUrl, apiKey, maxRetries, timeoutMs, backoffMs } = this.#opts
    for (let attempt = 0; ; attempt++) {
      let res: Response
      try {
        res = await this.#opts.fetch(`${baseUrl}${path}`, {
          method,
          headers: { 'content-type': 'application/json', 'x-definitive-api-key': apiKey },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
      } catch (err) {
        if (attempt < maxRetries) {
          await sleep(backoffMs * 2 ** attempt)
          continue
        }
        throw new FlashApiError(
          0,
          'NETWORK_ERROR',
          err instanceof Error ? err.message : String(err),
        )
      }
      if ((res.status === 429 || res.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(res.headers.get('retry-after'))
        await sleep(
          Number.isFinite(retryAfter) && retryAfter > 0
            ? retryAfter * 1000
            : backoffMs * 2 ** attempt,
        )
        continue
      }
      const text = await res.text()
      const json = text ? safeJson(text) : undefined
      if (!res.ok) {
        const err = (json as { error?: { code?: string; message?: string; details?: unknown } })
          ?.error
        throw new FlashApiError(
          res.status,
          err?.code ?? 'HTTP_ERROR',
          err?.message ?? text.slice(0, 200),
          err?.details,
        )
      }
      return json as T
    }
  }

  async search(query: string, chain?: FlashChain, limit = 10): Promise<FlashAsset[]> {
    const params = new URLSearchParams({ query, limit: String(limit) })
    if (chain) params.set('chain', chain)
    return (await this.#request<{ assets: FlashAsset[] }>('GET', `/search?${params}`)).assets
  }

  quote(req: QuoteRequest) {
    return this.#request<QuoteResponse>('POST', '/quote', req)
  }

  submitOrder(req: SubmitOrderRequest) {
    return this.#request<SubmitOrderResponse>('POST', '/order', req)
  }

  getOrder(orderId: string, funderAddress: string) {
    const params = new URLSearchParams({ funderAddress })
    return this.#request<GetOrderResponse>(
      'GET',
      `/orders/${encodeURIComponent(orderId)}?${params}`,
    )
  }

  async cancelOrder(orderId: string, userSignature: string) {
    await this.#request('POST', `/orders/${encodeURIComponent(orderId)}/cancel`, {
      cancelMessage: cancelMessage(orderId),
      userSignature,
    })
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}
