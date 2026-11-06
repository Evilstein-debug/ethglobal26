import assert from 'node:assert/strict'
import { test } from 'node:test'
import { freshDb } from '../db/testing'
import { call, startApi, user } from './fakes'
import { hashSignal, rpSignature, walletSignal } from '@starter/world'
import { worldHumanVerifier } from '../auth/human'

const policy = { perTradeCap: '5', roundTradeCap: '10', dailyCap: '20', predictionsPerRound: 5 }

async function verified(base: string, seed: number, human: string) {
  const u = user(seed)
  const res = await call(base, 'POST', '/api/owners/verify', {
    auth: await u.auth(),
    body: { proof: { devHuman: human } },
  })
  return { u, res }
}

test('auth: missing, malformed, expired and forged signatures are rejected', async () => {
  const { base } = await startApi(await freshDb())
  const bob = user(1)
  const body = { proof: { devHuman: 'bob' } }
  assert.equal(
    (await call(base, 'POST', '/api/owners/verify', { body })).body.error,
    'auth_required',
  )
  assert.equal(
    (await call(base, 'POST', '/api/owners/verify', { body, auth: 'Arena nope' })).body.error,
    'auth_required',
  )
  const old = await bob.auth(Date.now() - 11 * 60_000)
  assert.equal(
    (await call(base, 'POST', '/api/owners/verify', { body, auth: old })).body.error,
    'auth_expired',
  )
  // Bob's signature presented as Alice's wallet.
  const forged = (await bob.auth()).replace(
    bob.address.toLowerCase(),
    user(2).address.toLowerCase(),
  )
  assert.equal(
    (await call(base, 'POST', '/api/owners/verify', { body, auth: forged })).body.error,
    'auth_invalid',
  )
})

test('verify: one human, one account (the World alternative paths)', async () => {
  const { base, arenaCalls } = await startApi(await freshDb())
  const { u: bob, res } = await verified(base, 1, 'bob')
  assert.equal(res.status, 201)
  assert.equal(res.body.method, 'dev')
  assert.equal(arenaCalls[0]?.fn, 'registerOwner')

  const again = await call(base, 'POST', '/api/owners/verify', {
    auth: await bob.auth(),
    body: { proof: { devHuman: 'bob' } },
  })
  assert.deepEqual([again.status, again.body.error], [409, 'already_verified'])

  const { res: secondWallet } = await verified(base, 2, 'bob') // same human, new wallet
  assert.deepEqual(
    [secondWallet.status, secondWallet.body.error],
    [409, 'human_already_registered'],
  )

  const { res: cancelled } = await verified(base, 3, 'cancel')
  assert.deepEqual([cancelled.status, cancelled.body.error], [400, 'verification_cancelled'])
  const bad = await call(base, 'POST', '/api/owners/verify', {
    auth: await user(4).auth(),
    body: { proof: {} },
  })
  assert.deepEqual([bad.status, bad.body.error], [400, 'invalid_proof'])
})

test('agents: unverified owners cannot create agents', async () => {
  const { base } = await startApi(await freshDb())
  const res = await call(base, 'POST', '/api/agents', {
    auth: await user(9).auth(),
    body: { name: 'Alpha', mode: 'trade', policy },
  })
  assert.deepEqual([res.status, res.body.error], [403, 'not_verified'])
})

test('agents: create, read publicly without secrets, registered onchain', async () => {
  const { base, arenaCalls } = await startApi(await freshDb())
  const { u: bob } = await verified(base, 1, 'bob')
  const created = await call(base, 'POST', '/api/agents', {
    auth: await bob.auth(),
    body: { name: 'Alpha', mode: 'trade', policy },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const agent = created.body as {
    id: string
    address: string
    owner: string
    registerTx: string
    policy: { perTradeCap: string }
  }
  assert.equal(agent.owner, bob.address)
  assert.equal(agent.policy.perTradeCap, '5')
  assert.match(agent.registerTx, /^0x/)
  assert.equal(arenaCalls.at(-1)?.fn, 'registerAgent')
  assert.equal((arenaCalls.at(-1)?.args[0] as string).toLowerCase(), agent.address.toLowerCase())

  const read = await call(base, 'GET', `/api/agents/${agent.id}`)
  assert.equal(read.status, 200)
  assert.ok(!JSON.stringify(read.body).includes('enc'), 'no key material in public view')
  const owner = await call(base, 'GET', `/api/owners/${bob.address}`)
  assert.equal((owner.body.agents as unknown[]).length, 1)
  assert.equal((await call(base, 'GET', '/api/agents/nope')).status, 404)
})

test('agents: input validation', async () => {
  const { base } = await startApi(await freshDb())
  const { u: bob } = await verified(base, 1, 'bob')
  const auth = await bob.auth()
  const bad = async (body: unknown) =>
    (await call(base, 'POST', '/api/agents', { auth, body })).body.error
  assert.equal(await bad({ name: 'A', mode: 'yolo', policy }), 'invalid_request')
  assert.equal(
    await bad({ name: 'A', mode: 'trade', policy: { ...policy, perTradeCap: '11' } }),
    'invalid_request',
  )
  assert.equal(
    await bad({ name: 'A', mode: 'trade', policy: { ...policy, dailyCap: '5000' } }),
    'invalid_request',
  )
  assert.equal(
    await bad({ name: 'A', mode: 'trade', policy: { ...policy, perTradeCap: '-1' } }),
    'invalid_request',
  )
  assert.equal(await bad({ name: 'A', mode: 'trade', policy, encKey: 'x' }), 'invalid_request')
})

test('agents: only the owner can change policy, pause, preview or withdraw', async () => {
  const { base } = await startApi(await freshDb())
  const { u: bob } = await verified(base, 1, 'bob')
  const { u: alice } = await verified(base, 2, 'alice')
  const { body } = await call(base, 'POST', '/api/agents', {
    auth: await bob.auth(),
    body: { name: 'Alpha', mode: 'trade', policy },
  })
  const id = body.id as string
  const aliceAuth = await alice.auth()
  for (const [method, path, payload] of [
    ['PATCH', 'policy', policy],
    ['POST', 'pause', undefined],
    ['POST', 'resume', undefined],
    ['POST', 'trade-preview', { amount: '1', asset: 'WETH' }],
    ['POST', 'withdraw', { asset: 'USDC', amount: '1' }],
  ] as const) {
    const res = await call(base, method, `/api/agents/${id}/${path}`, {
      auth: aliceAuth,
      body: payload,
    })
    assert.deepEqual([res.status, res.body.error], [403, 'not_agent_owner'], path)
  }
})

test('agents: pause, policy update and trade preview with deny reasons', async () => {
  const { base, usdcBalances } = await startApi(await freshDb())
  const { u: bob } = await verified(base, 1, 'bob')
  const auth = await bob.auth()
  const { body } = await call(base, 'POST', '/api/agents', {
    auth,
    body: { name: 'Alpha', mode: 'trade', policy },
  })
  const id = body.id as string
  usdcBalances.set((body.address as string).toLowerCase(), 3_000_000n) // 3 USDC

  const preview = async (amount: string, asset = 'WETH') =>
    (await call(base, 'POST', `/api/agents/${id}/trade-preview`, { auth, body: { amount, asset } }))
      .body
  assert.deepEqual(await preview('2'), { allowed: true })
  assert.deepEqual(await preview('6'), { allowed: false, reason: 'over_trade_cap' })
  assert.deepEqual(await preview('4'), { allowed: false, reason: 'insufficient_funds' })
  assert.deepEqual(await preview('1', 'PEPE'), { allowed: false, reason: 'asset_not_allowed' })

  const paused = await call(base, 'POST', `/api/agents/${id}/pause`, { auth })
  assert.equal(paused.body.status, 'paused')
  assert.deepEqual(await preview('1'), { allowed: false, reason: 'paused' })
  await call(base, 'POST', `/api/agents/${id}/resume`, { auth })

  const updated = await call(base, 'PATCH', `/api/agents/${id}/policy`, {
    auth,
    body: { ...policy, perTradeCap: '1' },
  })
  assert.equal((updated.body.policy as { perTradeCap: string }).perTradeCap, '1')
  assert.deepEqual(await preview('2'), { allowed: false, reason: 'over_trade_cap' })
  // A preview never reserves budget.
  assert.equal(updated.body.reservedUsdc, '0')
})

test('agents: at most five per owner', async () => {
  const { base } = await startApi(await freshDb())
  const { u: bob } = await verified(base, 1, 'bob')
  const auth = await bob.auth()
  for (let i = 0; i < 5; i++) {
    assert.equal(
      (
        await call(base, 'POST', '/api/agents', {
          auth,
          body: { name: `A${i}`, mode: 'predict', policy },
        })
      ).status,
      201,
    )
  }
  const sixth = await call(base, 'POST', '/api/agents', {
    auth,
    body: { name: 'A6', mode: 'predict', policy },
  })
  assert.deepEqual([sixth.status, sixth.body.error], [409, 'agent_limit_reached'])
})

test('unknown routes and bad JSON get JSON errors', async () => {
  const { base } = await startApi(await freshDb())
  assert.deepEqual((await call(base, 'GET', '/api/nope')).body, { error: 'not_found' })
  const res = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{',
  })
  assert.equal(res.status, 400)
})

// ── World ID route behaviour (portal faked; proof checks are real) ──────────────────────

function worldProof(wallet: string, nullifier: string) {
  return {
    protocol_version: '4.0',
    action: 'agentarena-owner-v1',
    environment: 'production',
    responses: [
      {
        identifier: 'proof_of_human',
        signal_hash: hashSignal(walletSignal(wallet)),
        proof: ['0x1'],
        nullifier,
      },
    ],
  }
}

async function worldApi() {
  const portal = (async () =>
    new Response(
      JSON.stringify({ success: true, environment: 'production' }),
    )) as unknown as typeof fetch
  const cfg = {
    appId: 'app_t',
    rpId: 'rp_t',
    signingKeyHex: 'ab'.repeat(32),
    action: 'agentarena-owner-v1',
    environment: 'production' as const,
    fetch: portal,
  }
  return startApi(await freshDb(), {
    humanVerifier: worldHumanVerifier(cfg),
    world: {
      appId: cfg.appId,
      rpId: cfg.rpId,
      action: cfg.action,
      environment: cfg.environment,
      sign: () => rpSignature(cfg),
    },
  })
}

test('world: one human with two wallets (same nullifier, different casing) gets one account', async () => {
  const { base } = await worldApi()
  const bob = user(1)
  const bobAgain = user(2)
  const first = await call(base, 'POST', '/api/owners/verify', {
    auth: await bob.auth(),
    body: { proof: worldProof(bob.address, '0x0ABC') },
  })
  assert.deepEqual([first.status, first.body.method], [201, 'world'])
  const second = await call(base, 'POST', '/api/owners/verify', {
    auth: await bobAgain.auth(),
    body: { proof: worldProof(bobAgain.address, '0xabc') },
  })
  assert.deepEqual([second.status, second.body.error], [409, 'human_already_registered'])
})

test('world: a proof generated for another wallet cannot be replayed', async () => {
  const { base } = await worldApi()
  const victim = user(3)
  const thief = user(4)
  const res = await call(base, 'POST', '/api/owners/verify', {
    auth: await thief.auth(),
    body: { proof: worldProof(victim.address, '0x123') },
  })
  assert.deepEqual([res.status, res.body.error], [400, 'signal_mismatch'])
})

test('world: browser config exposes only public values; RP signature is server-made', async () => {
  const { base } = await worldApi()
  const config = await call(base, 'GET', '/api/world/config')
  assert.deepEqual(config.body, {
    method: 'world',
    app_id: 'app_t',
    rp_id: 'rp_t',
    action: 'agentarena-owner-v1',
    environment: 'production',
  })
  assert.ok(
    !JSON.stringify(config.body).includes('ab'.repeat(32)),
    'signing key never leaves the server',
  )
  const sig = await call(base, 'POST', '/api/world/rp-signature')
  assert.ok(sig.body.sig && sig.body.nonce && sig.body.expires_at)
  const { base: devBase } = await startApi(await freshDb())
  assert.equal((await call(devBase, 'POST', '/api/world/rp-signature')).status, 404)
})
