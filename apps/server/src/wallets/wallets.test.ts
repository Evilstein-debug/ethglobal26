import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeFunctionData, erc20Abi, type Address } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import { arenaAbi, tradeLogAbi } from '@starter/shared/generated'
import { createAgentKey } from './agent-keys'
import { checkTx, checkTypedData, type EgressConfig } from './egress'
import { KeyBox } from './keybox'
import { AgentSigner, EgressDenied } from './signer'

const MASTER = 'aa'.repeat(32)
const a = (n: number) => `0x${n.toString(16).padStart(40, '0')}` as Address
const cfg: EgressConfig = {
  chainId: 8453,
  owner: a(1),
  tradeLog: a(2),
  arena: a(3),
  tokens: [a(4), a(5)],
  flashSettlement: a(6),
}
const H = `0x${'11'.repeat(32)}` as const

test('KeyBox round-trips and binds the agent id', () => {
  const box = new KeyBox(MASTER)
  const { address, encKey } = createAgentKey(box, 'agent-1')
  const key = box.open(encKey, 'agent-1')
  assert.equal(privateKeyToAccount(key).address, address)
  assert.ok(!encKey.includes(key.slice(2)), 'sealed key must not contain the raw key')
  assert.throws(() => box.open(encKey, 'agent-2'), /auth|unable/i)
  assert.throws(() => new KeyBox('aa'.repeat(32)).open(encKey.replace(/.$/, 'A'), 'agent-1'))
  assert.throws(() => new KeyBox('bb'.repeat(32)).open(encKey, 'agent-1'))
  assert.throws(() => new KeyBox('short'), /32 bytes/)
})

test('TradeLog and Arena: only agent functions', () => {
  const commit = encodeFunctionData({ abi: tradeLogAbi, functionName: 'commit', args: [7n, H, H] })
  assert.deepEqual(checkTx(cfg, { to: cfg.tradeLog, data: commit }), {
    ok: true,
    kind: 'tradelog_commit',
  })
  const predict = encodeFunctionData({
    abi: arenaAbi,
    functionName: 'predict',
    args: [1n, true, 6000, H],
  })
  assert.equal(checkTx(cfg, { to: cfg.arena, data: predict }).ok, true)
  const claim = encodeFunctionData({ abi: arenaAbi, functionName: 'claim', args: [1n] })
  assert.deepEqual(checkTx(cfg, { to: cfg.arena, data: claim }), {
    ok: false,
    reason: 'arena_function_not_allowed',
  })
  assert.equal(checkTx(cfg, { to: cfg.tradeLog, data: '0xdeadbeef' }).ok, false)
  assert.deepEqual(checkTx(cfg, { to: cfg.tradeLog, data: commit, value: 1n }), {
    ok: false,
    reason: 'value_not_allowed',
  })
})

test('tokens: approve only to Flash settlement, transfer only to owner', () => {
  const approveFlash = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [cfg.flashSettlement!, 10n],
  })
  const approveOther = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'approve',
    args: [a(99), 10n],
  })
  const toOwner = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [cfg.owner, 10n],
  })
  const toOther = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transfer',
    args: [a(99), 10n],
  })
  const transferFrom = encodeFunctionData({
    abi: erc20Abi,
    functionName: 'transferFrom',
    args: [a(9), a(99), 10n],
  })
  assert.equal(checkTx(cfg, { to: a(4), data: approveFlash }).ok, true)
  assert.deepEqual(checkTx(cfg, { to: a(4), data: approveOther }), {
    ok: false,
    reason: 'approve_spender_not_allowed',
  })
  assert.equal(checkTx(cfg, { to: a(5), data: toOwner }).ok, true)
  assert.deepEqual(checkTx(cfg, { to: a(5), data: toOther }), {
    ok: false,
    reason: 'transfer_recipient_not_allowed',
  })
  assert.deepEqual(checkTx(cfg, { to: a(4), data: transferFrom }), {
    ok: false,
    reason: 'token_function_not_allowed',
  })
  assert.deepEqual(
    checkTx({ ...cfg, flashSettlement: undefined }, { to: a(4), data: approveFlash }),
    {
      ok: false,
      reason: 'flash_settlement_unset',
    },
  )
})

test('ETH only to the owner, without calldata; everything else is refused', () => {
  assert.equal(checkTx(cfg, { to: cfg.owner, value: 1n }).ok, true)
  assert.deepEqual(checkTx(cfg, { to: cfg.owner, value: 0n }), {
    ok: false,
    reason: 'zero_value_transfer',
  })
  assert.deepEqual(checkTx(cfg, { to: cfg.owner, data: '0x1234', value: 1n }), {
    ok: false,
    reason: 'owner_calldata_not_allowed',
  })
  assert.deepEqual(checkTx(cfg, { to: a(99), value: 1n }), {
    ok: false,
    reason: 'value_not_allowed',
  })
  assert.deepEqual(checkTx(cfg, { to: a(99) }), { ok: false, reason: 'destination_not_allowed' })
})

test('typed data: only the Flash settlement domain on this chain', () => {
  const ok = {
    domain: { chainId: 8453, verifyingContract: cfg.flashSettlement },
    primaryType: 'FlashOrder',
  }
  assert.equal(checkTypedData(cfg, ok).ok, true)
  assert.deepEqual(
    checkTypedData(cfg, { ...ok, domain: { ...ok.domain, verifyingContract: a(99) } }),
    {
      ok: false,
      reason: 'typed_data_domain_not_allowed',
    },
  )
  assert.deepEqual(checkTypedData(cfg, { ...ok, domain: { ...ok.domain, chainId: 1 } }), {
    ok: false,
    reason: 'typed_data_wrong_chain',
  })
  // A Permit2 / other dApp permit must never be signed.
  assert.equal(
    checkTypedData(cfg, { domain: { chainId: 8453 }, primaryType: 'PermitSingle' }).ok,
    false,
  )
})

test('signer refuses denied requests and honours pause before touching the network', async () => {
  let paused = false
  const signer = new AgentSigner({
    privateKey: `0x${'01'.repeat(32)}`,
    chain: anvil,
    rpcUrl: 'http://127.0.0.1:1', // unreachable: any network call would fail differently
    egress: { ...cfg, chainId: anvil.id },
    isPaused: async () => paused,
  })
  await assert.rejects(
    signer.sendTransaction({ to: a(99) }),
    (e: unknown) => e instanceof EgressDenied && e.reason === 'destination_not_allowed',
  )
  paused = true
  await assert.rejects(
    signer.sendTransaction({ to: cfg.owner, value: 1n }),
    (e: unknown) => e instanceof EgressDenied && e.reason === 'paused',
  )
  const typed = {
    domain: { chainId: anvil.id, verifyingContract: cfg.flashSettlement },
    types: { Order: [{ name: 'x', type: 'uint256' }] },
    primaryType: 'Order',
    message: { x: 1n },
  } as const
  await assert.rejects(
    signer.signTypedData(typed),
    (e: unknown) => e instanceof EgressDenied && e.reason === 'paused',
  )
  paused = false
  assert.match(await signer.signTypedData(typed), /^0x[0-9a-f]{130}$/)
})
