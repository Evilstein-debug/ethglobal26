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
  QuoteStream,
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

/** The slice of the standard WebSocket we use (Node 22 ships it; @types/node 20 does not). */
type Socket = {
  onopen: (() => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: (() => void) | null
  onclose: (() => void) | null
  send(data: string): void
  close(): void
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

  /**
   * Open a Quotes WebSocket session for a market order: resolves once the first quote arrives and
   * keeps collecting revisions until `close()`. Throws FlashApiError if the stream is unavailable,
   * so callers can fall back to `quote`. Docs: flash.definitive.fi/docs/api-reference/flash/websocket-quotes
   */
  openQuoteStream(req: QuoteRequest): Promise<QuoteStream> {
    const { baseUrl, apiKey, timeoutMs } = this.#opts
    const WS = (globalThis as unknown as { WebSocket?: new (url: string) => Socket }).WebSocket
    if (!WS) throw new FlashApiError(0, 'NO_WEBSOCKET', 'this runtime has no WebSocket')
    const subscriptionId = `q-${Math.random().toString(36).slice(2)}-${Date.now()}`
    return new Promise((resolve, reject) => {
      const ws = new WS(`${baseUrl.replace(/^http/, 'ws')}/ws`)
      let first: QuoteResponse | undefined
      let latest: QuoteResponse | undefined
      let revisions = 0
      let ended = false
      let settled = false
      const fail = (err: FlashApiError) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        ws.close()
        reject(err)
      }
      const timer = setTimeout(
        () => fail(new FlashApiError(0, 'STREAM_TIMEOUT', 'no quote from the stream')),
        timeoutMs,
      )
      ws.onopen = () =>
        ws.send(
          JSON.stringify({
            channel: 'quotes',
            type: 'subscribe',
            subscriptionId,
            apiKey,
            request: req,
          }),
        )
      ws.onmessage = (ev) => {
        const m = safeJson(String(ev.data)) as
          | {
              type?: string
              channel?: string
              code?: string
              message?: string
              subscriptionId?: string
              quote?: QuoteResponse
            }
          | undefined
        if (!m) return
        if (m.type === 'error' && (!m.subscriptionId || m.subscriptionId === subscriptionId)) {
          return fail(new FlashApiError(0, m.code ?? 'STREAM_ERROR', m.message ?? 'stream error'))
        }
        if (m.channel !== 'quotes' || m.subscriptionId !== subscriptionId) return
        if (m.type === 'quote_expired') ended = true
        if (m.type !== 'quote' || !m.quote) return
        latest = m.quote
        revisions++
        if (!first) {
          first = m.quote
          settled = true
          clearTimeout(timer)
          resolve({
            first,
            latest: () => latest!,
            revisions: () => revisions,
            close: () => {
              if (!ended) {
                ended = true
                try {
                  ws.send(
                    JSON.stringify({ channel: 'quotes', type: 'unsubscribe', subscriptionId }),
                  )
                } catch {
                  // the socket may already be gone
                }
              }
              ws.close()
            },
          })
        }
      }
      ws.onerror = () => fail(new FlashApiError(0, 'STREAM_ERROR', 'websocket error'))
      ws.onclose = () => fail(new FlashApiError(0, 'STREAM_CLOSED', 'websocket closed'))
    })
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
