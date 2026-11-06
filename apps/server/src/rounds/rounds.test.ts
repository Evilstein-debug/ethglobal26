import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, describe, test } from 'node:test'
import { LocalLLMStub } from '@starter/zerog'
import { arenaAbi, mockUsdcAbi } from '@starter/shared/generated'
import { verifyEntry, type EntryBundle } from '@starter/shared/verify'
import { eq } from 'drizzle-orm'
import type { Address } from 'viem'
import { createApp } from '../app'
import { localModel } from '../brain/local-model'
import { TRADE_SYSTEM } from '../brain/prompts'
import { schema } from '../db'
import { allocateAwards } from '../rewards/epoch'
import { createAgent, updatePolicy } from '../services/agents'
import { skipReason, startAnvilWorld } from '../test/anvil'
import { startPredictionIndexer } from './indexer'
import { brier } from './resolver'
import { tick, type RoundConfig } from './scheduler'

test('brier score', () => {
  assert.equal(brier(10_000, 'YES'), 0)
  assert.equal(brier(0, 'YES'), 1)
  assert.equal(brier(5_000, 'NO'), 0.25)
  assert.ok(Math.abs(brier(5_500, 'YES') - 0.2025) < 1e-12)
})

test('awards: shares, one per human, ranking order', () => {
  const r = (agentId: string, humanId: string, score: number) => ({
    agentId,
    humanId,
    ownerWallet: `w-${humanId}`,
    score,
  })
  const awards = allocateAwards(
    [r('a1', 'bob', 0.05), r('a2', 'bob', 0.04), r('a3', 'carol', 0.01)],
    [r('p1', 'bob', 0.1), r('p2', 'alice', 0.2)],
    5_000_000,
  )
  assert.deepEqual(
    awards.map((a) => [a.agentId, a.category, a.rank, a.amount]),
    [
      ['a1', 'trader', 1, 2_000_000],
      ['a3', 'trader', 2, 1_250_000], // bob's second trader skipped: one award per human
      ['p2', 'predictor', 1, 1_000_000], // bob already awarded → alice's predictor wins
    ],
  )
  assert.deepEqual(allocateAwards([], [], 5_000_000), [])
  assert.deepEqual(allocateAwards([r('a1', 'bob', 1)], [], 0), [])
})

const EPOCH = 10_000
const cfg: RoundConfig = {
  registrationMs: 1000,
  predictingMs: 1000,
  tradingMs: 1000,
  gapMs: 0,
  epochMs: EPOCH,
  epoch: { budget: 5_000_000, minEntries: 1, minPredictions: 1 },
  maxTradeDecisions: 2,
}
const policy = { perTradeCap: '5', dailyCap: '20', predictionsPerDay: 5 }

async function arena() {
  const w = await startAnvilWorld()
  let clock = EPOCH * 100_000
  w.ctx.now = () => clock
  w.ctx.llm = localModel()
  const bob = await w.owner(`bob${Math.random().toString(36).slice(2, 8)}`)
  const alice = await w.owner(`alice${Math.random().toString(36).slice(2, 8)}`)
  const alpha = await createAgent(w.ctx, bob.wallet, { name: 'Alpha', mode: 'trade', policy })
  const beta = await createAgent(w.ctx, alice.wallet, { name: 'Beta', mode: 'predict', policy })
  await w.fund(alpha.address as Address, '20')
  await w.fund(beta.address as Address, '0', '0.05')
  await w.fund(bob.wallet, '0', '0.05') // gas for claiming
  await w.fundPool('10')
  return { ...w, bob, alice, alpha, beta, at: (t: number) => (clock = EPOCH * 100_000 + t) }
}

/** The public entry bundle, exactly as a verifier gets it. */
async function bundleOf(w: Awaited<ReturnType<typeof arena>>, entryId: number) {
  const server = createApp(w.ctx).listen(0)
  after(() => server.close())
  const { port } = server.address() as AddressInfo
  const res = await fetch(`http://127.0.0.1:${port}/api/entries/${entryId}`)
  return (await res.json()) as EntryBundle
}

async function verifiedOk(w: Awaited<ReturnType<typeof arena>>, entryId: number) {
  const report = await verifyEntry(await bundleOf(w, entryId), w.publicClient, {
    chainId: w.ctx.chain.id,
  })
  assert.ok(report.ok, JSON.stringify(report.steps.filter((s) => s.status === 'fail')))
}

describe('rounds on anvil', { skip: skipReason }, () => {
  test('full round → YES → Brier → epoch published → owner claims', async () => {
    const w = await arena()
    assert.equal(await tick(w.ctx, cfg), 'started')
    const [entry] = await w.db.select().from(schema.roundEntries)
    assert.ok(entry?.onchainEntryId, 'trader entered round 1 onchain')
    assert.equal(entry!.tradeBudget, 5_000_000)

    w.at(1000)
    assert.equal(await tick(w.ctx, cfg), 'REGISTRATION') // → PREDICTING, Beta predicts
    assert.equal((await w.db.select().from(schema.predictions)).length, 1)

    w.at(2000)
    assert.equal(await tick(w.ctx, cfg), 'PREDICTING') // → lock + TRADING, Alpha trades
    assert.equal(
      await w.publicClient.readContract({
        address: w.contracts.arena,
        abi: arenaAbi,
        functionName: 'roundLocked',
        args: [1n],
      }),
      true,
    )
    const [intent] = await w.db.select().from(schema.intents)
    assert.equal(intent!.state, 'EXECUTED')

    w.stub.setPrice(3100) // take-profit (+1.5%) fires
    w.at(3000)
    assert.equal(await tick(w.ctx, cfg), 'TRADING') // → close, resolve, SETTLED
    const [resolved] = await w.db.select().from(schema.roundEntries)
    assert.equal(resolved!.outcome, 'YES')
    assert.ok(resolved!.pnlBps! > 0)
    const [, , onchainOutcome, onchainPnl] = await w.publicClient.readContract({
      address: w.contracts.arena,
      abi: arenaAbi,
      functionName: 'entries',
      args: [BigInt(resolved!.onchainEntryId!)],
    })
    assert.equal(onchainOutcome, 1)
    assert.equal(onchainPnl, resolved!.pnlBps)
    const [pred] = await w.db.select().from(schema.predictions)
    assert.ok(Math.abs(pred!.brier! - 0.2025) < 1e-9)
    const stats = await w.db.select().from(schema.agentStats)
    assert.equal(stats.find((s) => s.role === 'trader')!.wins, 1)
    assert.equal(stats.find((s) => s.role === 'predictor')!.wins, 1)

    // Epoch ends → awards published before the next round starts.
    w.at(EPOCH)
    assert.equal(await tick(w.ctx, cfg), 'started')
    const awards = await w.db.select().from(schema.rewardAwards)
    assert.deepEqual(awards.map((a) => [a.category, a.amount]).sort(), [
      ['predictor', 1_000_000],
      ['trader', 2_000_000],
    ])
    const [epoch] = await w.db
      .select()
      .from(schema.rewardEpochs)
      .where(eq(schema.rewardEpochs.id, 100_000))
    assert.equal(epoch!.status, 'published')

    const bobWallet = w.walletFor(w.bob.account)
    const hash = await bobWallet.writeContract({
      address: w.contracts.arena,
      abi: arenaAbi,
      functionName: 'claim',
      args: [100_000n],
    })
    assert.equal((await w.publicClient.waitForTransactionReceipt({ hash })).status, 'success')
    const bobUsdc = await w.publicClient.readContract({
      address: w.contracts.usdc,
      abi: mockUsdcAbi,
      functionName: 'balanceOf',
      args: [w.bob.wallet],
    })
    assert.equal(bobUsdc, 2_000_000n)

    // The indexer records the owner's claim tx.
    const stop = startPredictionIndexer(w.ctx, 20)
    for (let i = 0; i < 100; i++) {
      const [award] = await w.db
        .select()
        .from(schema.rewardAwards)
        .where(eq(schema.rewardAwards.ownerWallet, w.bob.wallet.toLowerCase()))
      if (award?.claimTx === hash) break
      assert.ok(i < 99, 'claim tx indexed')
      await new Promise((r) => setTimeout(r, 20))
    }
    stop()
  })

  test('verifyEntry: an honest entry passes; each tampered claim fails its step', async () => {
    const w = await arena()
    await tick(w.ctx, cfg)
    w.at(1000)
    await tick(w.ctx, cfg)
    w.at(2000)
    await tick(w.ctx, cfg)
    w.stub.setPrice(3100)
    w.at(3000)
    await tick(w.ctx, cfg)

    const bundle = await bundleOf(w, 1)
    const verify = async (mutate: (b: EntryBundle) => void = () => undefined) => {
      const copy = structuredClone(bundle)
      mutate(copy)
      const report = await verifyEntry(copy, w.publicClient, { chainId: w.ctx.chain.id })
      return { report, failed: report.steps.filter((s) => s.status === 'fail').map((s) => s.id) }
    }

    const honest = await verify()
    assert.deepEqual(honest.failed, [], JSON.stringify(honest.report.steps))
    assert.equal(honest.report.ok, true)
    // Anvil has no real fills or TEE: those steps never report a pass here.
    assert.deepEqual(
      honest.report.steps.filter((s) => s.status === 'skip').map((s) => s.id),
      ['commit-before-fill', 'fills-onchain', 'decisions'],
    )

    assert.deepEqual(
      (
        await verify((b) => {
          b.intents[0]!.usdcReceived! += 1_000_000 // inflate the exit
        })
      ).failed,
      ['pnl'],
    )
    assert.deepEqual(
      (
        await verify((b) => {
          b.entry.outcome = 'NO'
        })
      ).failed,
      ['entry-onchain', 'pnl', 'brier'],
    )
    assert.deepEqual(
      (
        await verify((b) => {
          b.intents[0]!.canonicalJson = b.intents[0]!.canonicalJson.replace('WETH', 'PEPE')
        })
      ).failed,
      ['commits'],
    )
    assert.ok(
      (
        await verify((b) => {
          b.intents = [] // hide the trade
        })
      ).failed.includes('commits'),
    )
    assert.deepEqual(
      (
        await verify((b) => {
          b.predictions[0]!.probYesBps = 9_900 // rewrite a prediction after the fact
        })
      ).failed,
      ['predictions-closed', 'brier'],
    )
    assert.ok(
      (
        await verify((b) => {
          b.round.lockTx = b.entry.openTx // a tx that isn't the lock
        })
      ).failed.includes('predictions-closed'),
    )
  })

  test('a trader that never trades is VOID; its predictions are not scored', async () => {
    const w = await arena()
    const model = localModel()
    w.ctx.llm = new LocalLLMStub(async (req) =>
      req.system === TRADE_SYSTEM
        ? JSON.stringify({ action: 'hold', rationale: 'flat' })
        : (await model.complete(req)).output,
    )
    for (const t of [0, 1000, 2000, 2600, 3000]) {
      w.at(t)
      await tick(w.ctx, cfg)
    }
    const [entry] = await w.db.select().from(schema.roundEntries)
    assert.deepEqual([entry!.outcome, entry!.voidReason], ['VOID', 'no_trades'])
    const [pred] = await w.db.select().from(schema.predictions)
    assert.equal(pred!.brier, null)
    // Two trade decisions were asked (start + mid-phase), both held.
    const trades = (await w.db.select().from(schema.decisions)).filter((d) => d.kind === 'trade')
    assert.equal(trades.length, 2)
    await verifiedOk(w, entry!.id)
  })

  test('changing the policy mid-round voids the entry', async () => {
    const w = await arena()
    for (const t of [0, 1000, 2000]) {
      w.at(t)
      await tick(w.ctx, cfg)
    }
    await updatePolicy(w.ctx, w.alpha.id, { ...policy, perTradeCap: '4' })
    w.at(3000)
    await tick(w.ctx, cfg)
    const [entry] = await w.db.select().from(schema.roundEntries)
    assert.deepEqual([entry!.outcome, entry!.voidReason], ['VOID', 'policy_changed'])
    // The position was still closed before resolution.
    const [intent] = await w.db.select().from(schema.intents)
    assert.equal(intent!.state, 'CLOSED')
    await verifiedOk(w, entry!.id)
  })

  test('a losing trade resolves NO and earns no trader award', async () => {
    const w = await arena()
    for (const t of [0, 1000, 2000]) {
      w.at(t)
      await tick(w.ctx, cfg)
    }
    w.stub.setPrice(2900) // stop-loss fires
    w.at(3000)
    await tick(w.ctx, cfg)
    const [entry] = await w.db.select().from(schema.roundEntries)
    assert.equal(entry!.outcome, 'NO')
    assert.ok(entry!.pnlBps! < 0)
    await verifiedOk(w, entry!.id)
    w.at(EPOCH)
    await tick(w.ctx, cfg)
    const awards = await w.db.select().from(schema.rewardAwards)
    assert.ok(awards.every((a) => a.category !== 'trader'))
  })
})
