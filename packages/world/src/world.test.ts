import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  hashSignal,
  normalizeNullifier,
  rpSignature,
  verifyWorldProof,
  walletSignal,
  type WorldConfig,
} from './index'

const WALLET = '0xAbCdEf0000000000000000000000000000000001'
const OTHER = '0x0000000000000000000000000000000000000002'

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; body: unknown }[] = []
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(init.body as string) })
    return new Response(JSON.stringify(body), { status })
  }) as unknown as typeof fetch
  return { fn, calls }
}

const cfg = (fetchFn: typeof fetch): WorldConfig => ({
  appId: 'app_test',
  rpId: 'rp_test',
  signingKeyHex: 'ab'.repeat(32),
  action: 'agentarena-owner-v1',
  environment: 'production',
  fetch: fetchFn,
})

const proofFor = (wallet: string, o: Record<string, unknown> = {}) => ({
  protocol_version: '4.0',
  nonce: 'n',
  action: 'agentarena-owner-v1',
  environment: 'production',
  responses: [
    {
      identifier: 'proof_of_human',
      signal_hash: hashSignal(walletSignal(wallet)),
      proof: ['0x1', '0x2', '0x3', '0x4', '0x5'],
      nullifier: '0x04E5F6',
      issuer_schema_id: 1,
      expires_at_min: 1756166400,
    },
  ],
  ...o,
})

test('valid proof bound to the wallet → verified with the portal, nullifier normalized', async () => {
  const { fn, calls } = fakeFetch(200, { success: true, environment: 'production' })
  const res = await verifyWorldProof(cfg(fn), proofFor(WALLET), WALLET)
  assert.deepEqual(res, { ok: true, nullifier: String(0x04e5f6) })
  assert.equal(calls[0]!.url, 'https://developer.world.org/api/v4/verify/rp_test')
  assert.equal((calls[0]!.body as { action: string }).action, 'agentarena-owner-v1')
})

test('the wallet is part of the proof: a proof made for another wallet is refused before the portal', async () => {
  const { fn, calls } = fakeFetch(200, { success: true, environment: 'production' })
  assert.deepEqual(await verifyWorldProof(cfg(fn), proofFor(OTHER), WALLET), {
    ok: false,
    reason: 'signal_mismatch',
  })
  assert.equal(calls.length, 0)
  // Same wallet with different casing still matches.
  const ok = await verifyWorldProof(
    cfg(fn),
    proofFor(WALLET.toLowerCase()),
    WALLET.toUpperCase().replace('0X', '0x'),
  )
  assert.equal(ok.ok, true)
})

test('wrong environment, action or credential is refused', async () => {
  const { fn } = fakeFetch(200, { success: true, environment: 'production' })
  const reason = async (proof: unknown) => {
    const r = await verifyWorldProof(cfg(fn), proof, WALLET)
    return r.ok ? 'ok' : r.reason
  }
  assert.equal(await reason(proofFor(WALLET, { environment: 'staging' })), 'wrong_environment')
  assert.equal(await reason(proofFor(WALLET, { action: 'other' })), 'wrong_action')
  const device = proofFor(WALLET)
  device.responses[0]!.identifier = 'device'
  assert.equal(await reason(device), 'credential_not_accepted')
  assert.equal(await reason({}), 'invalid_proof')
  assert.equal(await reason(null), 'invalid_proof')
})

test('portal rejection, environment mismatch and outages fail closed', async () => {
  for (const [status, body] of [
    [400, { code: 'invalid_proof' }],
    [200, { success: false }],
    [200, { success: true, environment: 'staging' }],
  ] as const) {
    const { fn } = fakeFetch(status, body)
    assert.deepEqual(await verifyWorldProof(cfg(fn), proofFor(WALLET), WALLET), {
      ok: false,
      reason: 'proof_rejected',
    })
  }
  const down = (async () => {
    throw new Error('ECONNREFUSED')
  }) as unknown as typeof fetch
  assert.deepEqual(await verifyWorldProof(cfg(down), proofFor(WALLET), WALLET), {
    ok: false,
    reason: 'world_unreachable',
  })
})

test('nullifier normalization removes casing and padding differences', () => {
  assert.equal(normalizeNullifier('0x04E5F6'), normalizeNullifier('0x4e5f6'))
  assert.throws(() => normalizeNullifier('04e5'))
  assert.throws(() => normalizeNullifier(`0x${'f'.repeat(65)}`))
})

test('RP signature is produced server-side with nonce and expiry', () => {
  const sig = rpSignature({ signingKeyHex: 'ab'.repeat(32), action: 'agentarena-owner-v1' })
  assert.match(sig.sig, /^0x[0-9a-f]+$/i)
  assert.ok(sig.nonce)
  assert.ok(Number(sig.expires_at) > Number(sig.created_at))
})
