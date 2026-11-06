import assert from 'node:assert/strict'
import { test } from 'node:test'
import { LocalLLMStub, ZeroGClient, ZeroGError } from './index'

function fakeFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  const calls: { url: string; init: RequestInit }[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return new Response(JSON.stringify(body), { status, headers })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const ok = {
  id: 'chatcmpl-1',
  model: 'glm-5.3',
  choices: [{ message: { content: '{"action":"hold","rationale":"flat"}' } }],
  x_0g_trace: {
    request_id: '0852f405-6c56-40c2-a800-e6fd70785065',
    provider: '0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C',
    tee_verified: true,
  },
}

test('sends sealed-inference request: private trust mode, verify_tee, JSON mode', async () => {
  const { fn, calls } = fakeFetch(200, ok, { 'ZG-Res-Key': 'chat-abc' })
  const client = new ZeroGClient({ apiKey: 'sk-test', fetch: fn })
  const res = await client.complete({ system: 'sys', user: 'data' })
  const { url, init } = calls[0]!
  const headers = init.headers as Record<string, string>
  const body = JSON.parse(init.body as string)
  assert.equal(url, 'https://router-api.0g.ai/v1/chat/completions')
  assert.equal(headers.authorization, 'Bearer sk-test')
  assert.equal(headers['X-0G-Provider-Trust-Mode'], 'private')
  assert.equal(body.model, 'glm-5.3')
  assert.equal(body.verify_tee, true)
  assert.deepEqual(body.response_format, { type: 'json_object' })
  assert.deepEqual(
    body.messages.map((m: { role: string }) => m.role),
    ['system', 'user'],
  )
  assert.equal(res.requestId, ok.x_0g_trace.request_id)
  assert.equal(res.provider, ok.x_0g_trace.provider)
  assert.equal(res.chatId, 'chat-abc')
  assert.equal(res.teeVerified, true)
  assert.equal(res.output, ok.choices[0]!.message.content)
})

test('chat ID falls back to the body id when the header is absent', async () => {
  const { fn } = fakeFetch(200, ok)
  assert.equal(
    (await new ZeroGClient({ apiKey: 'k', fetch: fn }).complete({ system: '', user: '' })).chatId,
    'chatcmpl-1',
  )
})

test('fails closed unless the TEE signature verified', async () => {
  for (const tee_verified of [false, null, undefined]) {
    const { fn } = fakeFetch(200, { ...ok, x_0g_trace: { ...ok.x_0g_trace, tee_verified } })
    await assert.rejects(
      new ZeroGClient({ apiKey: 'k', fetch: fn }).complete({ system: '', user: '' }),
      (e: unknown) =>
        e instanceof ZeroGError &&
        e.code === 'tee_unverified' &&
        e.trace?.requestId === ok.x_0g_trace.request_id,
      String(tee_verified),
    )
  }
})

test('no Router flag: our own check of the TEE signature decides, and still fails closed', async () => {
  const { tee_verified: _none, ...trace } = ok.x_0g_trace
  const { fn } = fakeFetch(200, { ...ok, x_0g_trace: trace })
  const client = (verifyTee: (p: string, c: string) => Promise<boolean | null>) =>
    new ZeroGClient({ apiKey: 'k', fetch: fn, verifyTee }).complete({ system: '', user: '' })

  const seen: string[] = []
  const res = await client(async (provider, chatId) => {
    seen.push(provider, chatId)
    return true
  })
  assert.equal(res.teeVerified, true)
  assert.deepEqual(seen, [ok.x_0g_trace.provider, 'chatcmpl-1'])

  for (const verify of [
    async () => false,
    async () => null,
    async () => {
      throw new Error('0G chain down')
    },
  ]) {
    await assert.rejects(
      client(verify),
      (e: unknown) => (e as ZeroGError).code === 'tee_unverified',
    )
  }
})

test('a false Router flag is never overruled by our own check', async () => {
  const { fn } = fakeFetch(200, { ...ok, x_0g_trace: { ...ok.x_0g_trace, tee_verified: false } })
  await assert.rejects(
    new ZeroGClient({ apiKey: 'k', fetch: fn, verifyTee: async () => true }).complete({
      system: '',
      user: '',
    }),
    (e: unknown) => (e as ZeroGError).code === 'tee_unverified',
  )
})

test('missing request id, empty output and HTTP errors are typed errors', async () => {
  const cases: [number, unknown, string][] = [
    [200, { ...ok, x_0g_trace: {} }, 'no_request_id'],
    [200, { ...ok, choices: [] }, 'empty_output'],
    [
      503,
      {
        error: {
          message: 'no provider available for trust mode: tier=private',
          code: 'no_provider_for_trust_mode',
        },
      },
      'no_provider_for_trust_mode',
    ],
    [401, { error: { message: 'bad key' } }, 'http_401'],
  ]
  for (const [status, body, code] of cases) {
    const { fn } = fakeFetch(status, body)
    await assert.rejects(
      new ZeroGClient({ apiKey: 'k', fetch: fn }).complete({ system: '', user: '' }),
      (e: unknown) => e instanceof ZeroGError && e.code === code,
      code,
    )
  }
})

test('refuses non-private trust modes and missing keys', () => {
  assert.throws(() => new ZeroGClient({ apiKey: 'k', trustMode: 'standard' as never }), /private/)
  assert.throws(() => new ZeroGClient({ apiKey: '' }), /apiKey/)
})

test('local stub is labeled and never looks like 0G', async () => {
  const stub = new LocalLLMStub(() => '{"ok":true}')
  const res = await stub.complete({ system: 's', user: 'u' })
  assert.equal(stub.kind, 'local-stub')
  assert.equal(res.model, 'local-stub')
  assert.match(res.requestId, /^local-/)
  assert.equal(res.teeVerified, null)
  assert.equal(stub.calls.length, 1)
})
