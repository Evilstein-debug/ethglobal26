/**
 * 0G Private Computer (0G Compute Router) client.
 * Docs: https://docs.0g.ai/developer-hub/building-on-0g/compute-network/router/overview
 *
 * - OpenAI-compatible POST {baseUrl}/chat/completions with `Authorization: Bearer sk-…`.
 * - Sealed inference only: header `X-0G-Provider-Trust-Mode: private` routes to TeeML providers
 *   and never silently downgrades (503 instead).
 * - `verify_tee: true` makes the Router verify the provider's TEE signature; the result is
 *   `x_0g_trace.tee_verified`. We reject anything but `true` (fail closed).
 * - Every response carries `x_0g_trace.request_id` and `provider`; the `ZG-Res-Key` header is the
 *   chat ID a third party needs for independent verification (scripts/verify.ts).
 */

export type ZeroGTrace = {
  requestId: string
  provider: string
  chatId: string | null
  model: string
  teeVerified: boolean | null
  latencyMs: number
}

export type LLMResult = ZeroGTrace & {
  /** The model's raw text output (persisted as-is). */
  output: string
}

export type ChatRequest = {
  system: string
  user: string
  maxTokens?: number
  temperature?: number
}

/** What the brain needs from a model host. ZeroGClient is the real one. */
export interface LLMClient {
  readonly kind: '0g' | 'local-stub'
  readonly model: string
  complete(req: ChatRequest): Promise<LLMResult>
}

export class ZeroGError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
    /** Present when the call reached 0G: the request still has an ID worth recording. */
    readonly trace?: Partial<ZeroGTrace>,
  ) {
    super(`0G ${code}: ${message}`)
    this.name = 'ZeroGError'
  }
}

export type ZeroGClientOptions = {
  apiKey: string
  baseUrl?: string
  model?: string
  /** 'private' = TeeML only (default). Anything else is refused: the prize needs sealed inference. */
  trustMode?: 'private'
  /** Require x_0g_trace.tee_verified === true (default true). */
  requireTee?: boolean
  timeoutMs?: number
  fetch?: typeof fetch
}

type ChatResponse = {
  id?: string
  model?: string
  choices?: { message?: { content?: string | null } }[]
  x_0g_trace?: { request_id?: string; provider?: string; tee_verified?: boolean | null }
  error?: { message?: string; code?: string }
}

export class ZeroGClient implements LLMClient {
  readonly kind = '0g' as const
  readonly model: string
  readonly #o: Required<Omit<ZeroGClientOptions, 'fetch' | 'model'>> & { fetch: typeof fetch }

  constructor(opts: ZeroGClientOptions) {
    if (!opts.apiKey) throw new Error('ZeroGClient: apiKey is required')
    if (opts.trustMode && opts.trustMode !== 'private')
      throw new Error('ZeroGClient: only trust mode "private" is allowed')
    this.model = opts.model ?? 'glm-5.3'
    this.#o = {
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? 'https://router-api.0g.ai/v1',
      trustMode: 'private',
      requireTee: opts.requireTee ?? true,
      timeoutMs: opts.timeoutMs ?? 60_000,
      fetch: opts.fetch ?? globalThis.fetch,
    }
  }

  async complete(req: ChatRequest): Promise<LLMResult> {
    const started = Date.now()
    let res: Response
    try {
      res = await this.#o.fetch(`${this.#o.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.#o.apiKey}`,
          'X-0G-Provider-Trust-Mode': this.#o.trustMode,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: req.system },
            { role: 'user', content: req.user },
          ],
          response_format: { type: 'json_object' },
          verify_tee: true,
          temperature: req.temperature ?? 0.2,
          max_tokens: req.maxTokens ?? 800,
        }),
        signal: AbortSignal.timeout(this.#o.timeoutMs),
      })
    } catch (err) {
      throw new ZeroGError('network_error', err instanceof Error ? err.message : String(err))
    }
    const latencyMs = Date.now() - started
    const text = await res.text()
    let body: ChatResponse | undefined
    try {
      body = text ? (JSON.parse(text) as ChatResponse) : undefined
    } catch {
      body = undefined
    }
    if (!res.ok) {
      const code = body?.error?.code ?? `http_${res.status}`
      throw new ZeroGError(code, body?.error?.message ?? text.slice(0, 200), res.status)
    }
    const trace: ZeroGTrace = {
      requestId: body?.x_0g_trace?.request_id ?? '',
      provider: body?.x_0g_trace?.provider ?? '',
      chatId: res.headers.get('ZG-Res-Key') ?? body?.id ?? null,
      model: body?.model ?? this.model,
      teeVerified: body?.x_0g_trace?.tee_verified ?? null,
      latencyMs,
    }
    if (!trace.requestId)
      throw new ZeroGError(
        'no_request_id',
        'response has no x_0g_trace.request_id',
        res.status,
        trace,
      )
    if (this.#o.requireTee && trace.teeVerified !== true) {
      throw new ZeroGError(
        'tee_unverified',
        `tee_verified=${String(trace.teeVerified)}`,
        res.status,
        trace,
      )
    }
    const output = body?.choices?.[0]?.message?.content ?? ''
    if (!output) throw new ZeroGError('empty_output', 'no message content', res.status, trace)
    return { ...trace, output }
  }
}

/**
 * LOCAL TEST ONLY: a scripted model for anvil and tests. It returns whatever `respond` produces
 * for each request and labels every result `kind: 'local-stub'`, model `local-stub`, and a
 * `local-` request ID, so stub decisions can never pass for 0G ones.
 */
export class LocalLLMStub implements LLMClient {
  readonly kind = 'local-stub' as const
  readonly model = 'local-stub'
  readonly calls: ChatRequest[] = []
  #n = 0
  constructor(private readonly respond: (req: ChatRequest) => string | Promise<string>) {}

  async complete(req: ChatRequest): Promise<LLMResult> {
    this.calls.push(req)
    const output = await this.respond(req)
    return {
      requestId: `local-${Date.now()}-${++this.#n}`,
      provider: 'local-stub',
      chatId: null,
      model: this.model,
      teeVerified: null,
      latencyMs: 0,
      output,
    }
  }
}
