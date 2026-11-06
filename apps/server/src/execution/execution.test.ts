import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { canonicalHash } from '@starter/shared/canonical'
import { tradeLogAbi } from '@starter/shared/generated'
import { eq } from 'drizzle-orm'
import { encodeFunctionData, erc20Abi, type Address, type Hex } from 'viem'
import { schema } from '../db'
import { createAgent } from '../services/agents'
import { skipReason, startAnvilWorld } from '../test/anvil'
import { closePosition, realizedPnl, syncExit } from './close'
import { executeTrade, newIntentId, recoverStuckIntents } from './trade'

const policy = { perTradeCap: '5', dailyCap: '20' }

function intentFor(agent: Address, overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    intentId: newIntentId(),
    roundId: 1,
    agentAddress: agent,
    asset: 'WETH',
    side: 'long',
    entryRefPrice: '3000',
    sizeQuote: '5',
    orderType: 'bracket',
    stopPrice: '2950',
    targetPrice: '3060',
    rationale: 'test',
    zeroG: { requestId: `req-${Math.random()}`, model: 'manual' },
    createdAt: new Date().toISOString(),
    ...overrides,
  }
}

async function setup(opts: { usdc?: string; eth?: string } = {}) {
  const world = await startAnvilWorld()
  const bob = await world.owner(`bob${Math.random().toString(36).slice(2, 8)}`)
  const view = await createAgent(world.ctx, bob.wallet, { name: 'Alpha', mode: 'trade', policy })
  const agent = view.address as Address
  await world.fund(agent, opts.usdc ?? '20', opts.eth ?? '0.05')
  const onchain = async (intentHash: Hex) => {
    const [, , , status] = await world.publicClient.readContract({
      address: world.contracts.tradeLog,
      abi: tradeLogAbi,
      functionName: 'intents',
      args: [intentHash],
    })
    return ['None', 'Committed', 'Executed', 'Failed'][status]
  }
  return { ...world, agent, agentId: view.id, onchain }
}

describe('trade pipeline on anvil', { skip: skipReason }, () => {
  test('commit → quote → approve → sign → submit → fill → recordExecution', async () => {
    const { ctx, agent, agentId, stub, onchain, publicClient } = await setup()
    const intent = intentFor(agent)
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'executed', JSON.stringify(res))
    if (res.status !== 'executed') return
    assert.equal(res.intentHash, canonicalHash(intent))
    assert.equal(await onchain(res.intentHash), 'Executed')
    assert.ok(res.bracketOrderId, 'bracket pair is live')
    assert.equal(stub.submitted.length, 1)

    // The commit landed in a block before the execution record.
    const [commit, record] = await Promise.all([
      publicClient.getTransactionReceipt({ hash: res.commitTx }),
      publicClient.getTransactionReceipt({ hash: res.recordTx }),
    ])
    assert.ok(commit.blockNumber < record.blockNumber)

    const [row] = await ctx.db
      .select()
      .from(schema.intents)
      .where(eq(schema.intents.intentId, intent.intentId))
    assert.equal(row!.state, 'EXECUTED')
    assert.equal(row!.usdcSpent, 5_000_000)
    const [ledger] = await ctx.db
      .select()
      .from(schema.spendLedger)
      .where(eq(schema.spendLedger.agentId, agentId))
    assert.equal(ledger!.status, 'settled')

    // USDC approval went to the Flash spender only.
    const allowance = await publicClient.readContract({
      address: ctx.contracts.usdc,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [agent, ctx.flash!.approvalSpenders[0]!],
    })
    assert.ok(allowance > 0n)
  })

  test('no order without a prior commit: a failed commit never reaches Flash', async () => {
    const { ctx, agent, agentId, stub, onchain } = await setup({ eth: '0' }) // no gas → commit cannot be sent
    const intent = intentFor(agent)
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'failed')
    assert.equal(stub.submitted.length, 0, 'nothing submitted to Flash')
    assert.equal(await onchain(canonicalHash(intent)), 'None')
    const [ledger] = await ctx.db
      .select()
      .from(schema.spendLedger)
      .where(eq(schema.spendLedger.agentId, agentId))
    assert.equal(ledger!.status, 'released')
  })

  test('policy denial: nothing onchain, nothing at Flash', async () => {
    const { ctx, agent, stub } = await setup()
    const res = await executeTrade(ctx, intentFor(agent, { sizeQuote: '6' }))
    assert.deepEqual(res, { status: 'denied', reason: 'over_trade_cap' })
    assert.equal(stub.submitted.length, 0)
    assert.equal((await ctx.db.select().from(schema.intents)).length, 0)
  })

  test('a Flash failure after commit is recorded onchain as a failure and budget is released', async () => {
    const { ctx, agent, agentId, onchain } = await setup()
    const realSubmit = ctx.flash!.api.submitOrder.bind(ctx.flash!.api)
    ctx.flash!.api.submitOrder = async () => {
      throw new Error('simulated 400 from Flash')
    }
    const intent = intentFor(agent)
    const res = await executeTrade(ctx, intent)
    ctx.flash!.api.submitOrder = realSubmit
    assert.equal(res.status, 'failed')
    assert.equal(res.status === 'failed' && res.reason, 'submit_failed')
    assert.equal(await onchain(canonicalHash(intent)), 'Failed')
    const [ledger] = await ctx.db
      .select()
      .from(schema.spendLedger)
      .where(eq(schema.spendLedger.agentId, agentId))
    assert.equal(ledger!.status, 'released')
  })

  test('the signer refuses an approval to an unknown spender (egress allowlist)', async () => {
    const { ctx, agent, stub, onchain } = await setup()
    const realQuote = ctx.flash!.api.quote.bind(ctx.flash!.api)
    ctx.flash!.api.quote = async (req) => {
      const q = await realQuote(req)
      q.evm!.approveTx = {
        to: ctx.contracts.usdc,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: 'approve',
          args: ['0x000000000000000000000000000000000000bad1', 1n],
        }),
      }
      return q
    }
    const intent = intentFor(agent)
    const res = await executeTrade(ctx, intent)
    ctx.flash!.api.quote = realQuote
    assert.equal(res.status === 'failed' && res.reason, 'approve_failed')
    assert.match(res.status === 'failed' ? (res.detail ?? '') : '', /approve_spender_not_allowed/)
    assert.equal(stub.submitted.length, 0)
    assert.equal(await onchain(canonicalHash(intent)), 'Failed')
  })

  test('close: take-profit fired → closed via the bracket with positive PnL', async () => {
    const { ctx, agent, stub } = await setup()
    const intent = intentFor(agent)
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'executed')
    stub.setPrice(3100)
    const closed = await closePosition(ctx, intent.intentId)
    assert.equal(closed.status, 'closed', JSON.stringify(closed))
    assert.equal(closed.status === 'closed' && closed.via, 'bracket')
    const [row] = await ctx.db
      .select()
      .from(schema.intents)
      .where(eq(schema.intents.intentId, intent.intentId))
    assert.equal(row!.state, 'CLOSED')
    assert.ok(realizedPnl(row!)! > 0)
  })

  test('close: no leg fired → bracket cancelled with a signed message, then market sell', async () => {
    const { ctx, agent, stub } = await setup()
    const intent = intentFor(agent)
    const res = await executeTrade(ctx, intent)
    assert.equal(res.status, 'executed')
    stub.setPrice(3010)
    const closed = await closePosition(ctx, intent.intentId)
    assert.equal(closed.status === 'closed' && closed.via, 'market', JSON.stringify(closed))
    const bracket = await ctx.flash!.api.getOrder(
      res.status === 'executed' ? res.bracketOrderId! : '',
      agent,
    )
    assert.equal(bracket.order.status, 'ORDER_STATUS_CANCELLED')
    stub.setPrice(4000) // the cancelled bracket must not fire later
    assert.equal(
      (await ctx.flash!.api.getOrder(bracket.order.orderId, agent)).order.status,
      'ORDER_STATUS_CANCELLED',
    )
    const [row] = await ctx.db
      .select()
      .from(schema.intents)
      .where(eq(schema.intents.intentId, intent.intentId))
    assert.equal(row!.state, 'CLOSED')
    assert.ok(row!.flashCloseOrderId)
    // Up only 0.33% with 0.3% fees each way → realized loss: fees matter (CLAUDE.md §4 row 9).
    assert.ok(realizedPnl(row!)! < 0)
  })

  test('syncExit: sees a fired bracket, and leaves an open position alone', async () => {
    const { ctx, agent, stub, db } = await setup()
    const intent = intentFor(agent)
    await executeTrade(ctx, intent)
    assert.equal(await syncExit(ctx, intent.intentId), null)
    stub.setPrice(3100)
    const exit = await syncExit(ctx, intent.intentId)
    assert.ok(exit?.status === 'closed' && exit.via === 'bracket')
    const [row] = await db.select().from(schema.intents)
    assert.equal(row!.state, 'CLOSED')
  })

  // A process that dies mid-trade: the Flash call never returns, and nothing finishes the intent.
  const crashAt = async (
    w: Awaited<ReturnType<typeof setup>>,
    method: 'getOrder' | 'submitOrder',
  ) => {
    const real = w.stub[method]
    let reached = false
    w.stub[method] = (() => {
      reached = true
      return new Promise(() => undefined)
    }) as never
    void executeTrade(w.ctx, intentFor(w.agent))
    for (let i = 0; !reached; i++) {
      assert.ok(i < 500, 'trade reached the crash point')
      await new Promise((r) => setTimeout(r, 10))
    }
    w.stub[method] = real as never
    const [row] = await w.db.select().from(schema.intents)
    return { ...w.ctx, now: () => row!.updatedAt + 6 * 60_000 }
  }

  test('restart recovery: a filled order carries on as an open position', async () => {
    const w = await setup()
    const restarted = await crashAt(w, 'getOrder')
    await recoverStuckIntents(w.ctx) // too recent to touch: it may still be running
    assert.equal((await w.db.select().from(schema.intents))[0]!.state, 'EXECUTING')
    await recoverStuckIntents(restarted)
    const [row] = await w.db.select().from(schema.intents)
    assert.equal(row!.state, 'EXECUTED')
    assert.equal(await w.onchain(row!.intentHash as Hex), 'Executed')
    const [ledger] = await w.db.select().from(schema.spendLedger)
    assert.equal(ledger!.status, 'settled')
  })

  test('restart recovery: an order that never went out fails onchain and refunds', async () => {
    const w = await setup()
    const restarted = await crashAt(w, 'submitOrder')
    await recoverStuckIntents(restarted)
    const [row] = await w.db.select().from(schema.intents)
    assert.deepEqual([row!.state, row!.failReason], ['FAILED', 'recovered_after_restart'])
    assert.equal(await w.onchain(row!.intentHash as Hex), 'Failed')
    const [ledger] = await w.db.select().from(schema.spendLedger)
    assert.equal(ledger!.status, 'released')
  })

  test('close is a no-op for intents that never executed', async () => {
    const { ctx } = await setup()
    assert.deepEqual(await closePosition(ctx, 'nope'), {
      status: 'skipped',
      intentId: 'nope',
      reason: 'unknown_intent',
    })
  })
})
