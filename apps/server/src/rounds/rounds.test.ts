import assert from 'node:assert/strict'
import type { AddressInfo } from 'node:net'
import { after, describe, test } from 'node:test'
import { arenaAbi, mockUsdcAbi } from '@starter/shared/generated'
import { verifyEntry, type EntryBundle } from '@starter/shared/verify'
import { eq } from 'drizzle-orm'
import type { Address } from 'viem'
import { createApp } from '../app'
import { localModel } from '../brain/local-model'
import { schema } from '../db'
import { allocateAwards } from '../rewards/epoch'
import { createAgent, setPaused, updatePolicy } from '../services/agents'
import { skipReason, startAnvilWorld } from '../test/anvil'
import { startPredictionIndexer } from './indexer'
import { brier } from './resolver'
import { startScheduler, tick, type MarketConfig } from './scheduler'

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

const EPOCH = 100_000
const WINDOW = 1000
const HOLD = 5000
const GRACE = 2000
const cfg: MarketConfig = {
  predictionWindowMs: WINDOW,
  maxHoldMs: HOLD,
  thinkEveryMs: 0,
  minGasWei: 1n,
  closeGraceMs: GRACE,
  epochMs: EPOCH,
  epoch: { budget: 5_000_000, minEntries: 1, minPredictions: 1 },
}
const policy = { perTradeCap: '5', dailyCap: '20', predictionsPerDay: 5 }

async function arena() {
  const w = await startAnvilWorld()
  let clock = EPOCH * 100_000
  w.ctx.now = () => clock
  w.ctx.llm = localModel()
  // Long enough that an agent makes one trade per test.
  w.ctx.brain = { ...w.ctx.brain, tradeCooldownMs: EPOCH * 10 }
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

type World = Awaited<ReturnType<typeof arena>>

/** Alpha buys, the market opens and is broadcast, Beta predicts. Clock left at t=100. */
async function opened(w: World) {
  await tick(w.ctx, cfg)
  w.at(100)
  await tick(w.ctx, cfg)
  assert.equal((await w.db.select().from(schema.predictions)).length, 1, 'Beta predicted')
}

const market = async (w: World) => (await w.db.select().from(schema.rounds))[0]!
const entry = async (w: World) => (await w.db.select().from(schema.roundEntries))[0]!
const intent = async (w: World) => (await w.db.select().from(schema.intents))[0]!
const locked = (w: World, id = 1n) =>
  w.publicClient.readContract({
    address: w.contracts.arena,
    abi: arenaAbi,
    functionName: 'roundLocked',
    args: [id],
  })

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

describe('per-trade markets on anvil', { skip: skipReason }, () => {
  test('buy → broadcast → predict → lock → exit → YES → Brier → epoch → claim', async () => {
    const w = await arena()
    await tick(w.ctx, cfg) // Alpha decides and buys; the fill is broadcast
    const [e] = await w.db.select().from(schema.roundEntries)
    assert.ok(e?.onchainEntryId, 'market opened onchain right after the fill')
    assert.equal(e!.tradeBudget, 5_000_000)
    assert.equal((await intent(w)).entryId, e!.id)
    assert.equal((await intent(w)).state, 'EXECUTED')
    assert.equal((await market(w)).phase, 'PREDICTING')
    const log = await w.db.select().from(schema.agentActivity)
    assert.ok(log.some((a) => a.state === 'broadcast' && /make money/.test(a.message)))

    w.at(100)
    await tick(w.ctx, cfg) // Beta sees the broadcast and predicts
    assert.equal((await w.db.select().from(schema.predictions)).length, 1)

    w.at(WINDOW)
    await tick(w.ctx, cfg) // window over: locked, position still open
    assert.equal((await market(w)).phase, 'TRADING')
    assert.equal(await locked(w), true)
    assert.equal((await intent(w)).state, 'EXECUTED')

    w.stub.setPrice(3100) // take-profit (+1.5%) fires
    w.at(WINDOW + 100)
    await tick(w.ctx, cfg) // exit seen → resolve → SETTLED
    assert.equal((await market(w)).phase, 'SETTLED')
    const resolved = await entry(w)
    assert.equal(resolved.outcome, 'YES')
    assert.ok(resolved.pnlBps! > 0)
    const [, , onchainOutcome, onchainPnl] = await w.publicClient.readContract({
      address: w.contracts.arena,
      abi: arenaAbi,
      functionName: 'entries',
      args: [BigInt(resolved.onchainEntryId!)],
    })
    assert.equal(onchainOutcome, 1)
    assert.equal(onchainPnl, resolved.pnlBps)
    const [pred] = await w.db.select().from(schema.predictions)
    assert.ok(Math.abs(pred!.brier! - 0.2025) < 1e-9)
    const stats = await w.db.select().from(schema.agentStats)
    assert.equal(stats.find((s) => s.role === 'trader')!.wins, 1)
    assert.equal(stats.find((s) => s.role === 'predictor')!.wins, 1)
    await verifiedOk(w, resolved.id)

    // Epochs stay time-based and pay out from these markets.
    w.at(EPOCH)
    await tick(w.ctx, cfg)
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

  test('trade exits inside the window: predictions lock at once and late ones are refused', async () => {
    const w = await arena()
    await tick(w.ctx, cfg)
    w.stub.setPrice(3100)
    w.at(100) // long before the window ends
    await tick(w.ctx, cfg)
    assert.equal(await locked(w), true)
    assert.equal((await market(w)).phase, 'SETTLED')
    assert.equal((await entry(w)).outcome, 'YES')
    const betaEntry = await entry(w)
    const res = await w.publicClient
      .simulateContract({
        account: w.alice.account,
        address: w.contracts.arena,
        abi: arenaAbi,
        functionName: 'predict',
        args: [BigInt(betaEntry.onchainEntryId!), true, 9000, `0x${'0'.repeat(64)}`],
      })
      .then(
        () => 'accepted',
        (err: Error) => err.message,
      )
    assert.match(res, /RoundIsLocked/)
  })

  test('time limit: nothing fired, so the position is sold at market', async () => {
    const w = await arena()
    await opened(w)
    w.at(HOLD - 1)
    await tick(w.ctx, cfg)
    assert.equal((await market(w)).phase, 'TRADING')
    assert.equal((await intent(w)).state, 'EXECUTED')

    w.stub.setPrice(3005)
    w.at(HOLD)
    await tick(w.ctx, cfg)
    const i = await intent(w)
    assert.equal(i.state, 'CLOSED')
    assert.ok(i.flashCloseOrderId, 'sold by a market order, not a bracket leg')
    assert.equal((await market(w)).phase, 'SETTLED')
    assert.notEqual((await entry(w)).outcome, 'PENDING')
    await verifiedOk(w, (await entry(w)).id)
  })

  test('a trade nobody predicted on still counts for the trader', async () => {
    const w = await arena()
    await w.db
      .update(schema.agents)
      .set({ status: 'paused' })
      .where(eq(schema.agents.id, w.beta.id))
    await tick(w.ctx, cfg)
    w.stub.setPrice(3100)
    w.at(100)
    await tick(w.ctx, cfg)
    assert.equal((await w.db.select().from(schema.predictions)).length, 0)
    assert.equal((await entry(w)).outcome, 'YES')
    const [stats] = await w.db.select().from(schema.agentStats)
    assert.equal(stats!.wins, 1)
  })

  test('an order that fails after its commit is logged, refunds budget, and is never broadcast', async () => {
    const w = await arena()
    const submit = w.stub.submitOrder.bind(w.stub)
    w.stub.submitOrder = async () => {
      throw new Error('flash is down')
    }
    await tick(w.ctx, cfg)
    w.stub.submitOrder = submit
    const i = await intent(w)
    assert.equal(i.state, 'FAILED')
    assert.ok(i.commitTx && i.recordTx, 'the failure is onchain too')
    assert.equal((await w.db.select().from(schema.roundEntries)).length, 0, 'no market')
    assert.equal((await market(w)).phase, 'SETTLED')
    const ledger = await w.db.select().from(schema.spendLedger)
    assert.ok(ledger.every((l) => l.status === 'released'))
    const states = (await w.db.select().from(schema.agentActivity)).map((a) => a.state)
    assert.ok(!states.includes('broadcast'))
  })

  test('openEntry failing once does not lose the market: it retries', async () => {
    const w = await arena()
    const open = w.ctx.arena.openEntry
    w.ctx.arena.openEntry = async () => {
      throw new Error('rpc timeout')
    }
    await tick(w.ctx, cfg)
    assert.equal((await market(w)).phase, 'OPENING')
    w.ctx.arena.openEntry = open
    w.at(100)
    await tick(w.ctx, cfg)
    assert.equal((await market(w)).phase, 'PREDICTING')
    assert.ok((await entry(w)).openTx)
  })

  test('restart after openEntry landed but before it was saved: the market is recovered', async () => {
    const w = await arena()
    const open = w.ctx.arena.openEntry
    let hash: string | null = null
    w.ctx.arena.openEntry = async (id, trader) => {
      const res = await open(id, trader)
      hash = res.hash
      throw new Error('crashed right after the tx')
    }
    await tick(w.ctx, cfg)
    w.ctx.arena.openEntry = open
    w.at(100)
    await tick(w.ctx, cfg)
    assert.equal((await market(w)).phase, 'PREDICTING')
    assert.equal((await entry(w)).openTx, hash)
  })

  test('a reservation that never got a trade is cleared and blocks nothing', async () => {
    const w = await arena()
    await w.db.update(schema.agents).set({ status: 'paused' })
    await w.db
      .insert(schema.rounds)
      .values({ id: 1, phase: 'OPENING', epochId: 1, startsAt: w.ctx.now(), phaseEndsAt: 0 })
    w.at(GRACE + 1)
    await tick(w.ctx, cfg)
    assert.equal((await market(w)).phase, 'SETTLED')
  })

  test('pause during a trade: signing stays off, the entry voids after grace, resume cleans up', async () => {
    const w = await arena()
    await opened(w)
    await setPaused(w.ctx, w.alpha.id, true)
    w.at(HOLD)
    await tick(w.ctx, cfg)
    assert.equal(await locked(w), true, 'predictions lock regardless')
    assert.equal((await intent(w)).state, 'EXECUTED', 'pause blocks the sale')
    assert.equal((await market(w)).phase, 'TRADING')

    w.at(HOLD + GRACE)
    await tick(w.ctx, cfg)
    assert.equal((await market(w)).phase, 'SETTLED')
    const e = await entry(w)
    assert.deepEqual([e.outcome, e.voidReason], ['VOID', 'unsettled_intent'])
    const [pred] = await w.db.select().from(schema.predictions)
    assert.equal(pred!.brier, null, 'void entries are not scored')

    await setPaused(w.ctx, w.alpha.id, false)
    await tick(w.ctx, cfg)
    assert.equal((await intent(w)).state, 'CLOSED', 'leftover position sold after resume')
  })

  test('a bracket fires while paused: the exit is still seen and scored', async () => {
    const w = await arena()
    await opened(w)
    await setPaused(w.ctx, w.alpha.id, true)
    w.stub.setPrice(3100)
    w.at(200)
    await tick(w.ctx, cfg)
    assert.equal((await entry(w)).outcome, 'YES')
  })

  test('changing limits during a trade does not void it', async () => {
    const w = await arena()
    await opened(w)
    await updatePolicy(w.ctx, w.alpha.id, { ...policy, perTradeCap: '4' })
    w.stub.setPrice(2900) // stop-loss fires: a loss can't be dodged by editing limits
    w.at(200)
    await tick(w.ctx, cfg)
    const e = await entry(w)
    assert.equal(e.outcome, 'NO')
    await verifiedOk(w, e.id)
  })

  test('an epoch waits for its open markets', async () => {
    const w = await arena()
    w.ctx.brain = { ...w.ctx.brain, tradeCooldownMs: EPOCH * 10 }
    const slow = { ...cfg, maxHoldMs: EPOCH * 2 }
    await tick(w.ctx, slow)
    await tick(w.ctx, slow)
    const [epoch] = await w.db.select().from(schema.rewardEpochs).orderBy(schema.rewardEpochs.id)
    assert.equal(epoch!.status, 'open', 'market still open')
    w.stub.setPrice(3100)
    w.at(EPOCH + 200)
    await tick(w.ctx, slow)
    assert.equal((await market(w)).phase, 'SETTLED')
    const [settled] = await w.db.select().from(schema.rewardEpochs).orderBy(schema.rewardEpochs.id)
    assert.equal(settled!.status, 'published')
  })

  test('left alone, the two loops run a whole trade with nobody ticking them', async () => {
    const w = await arena()
    w.ctx.now = () => Date.now()
    const live = { ...cfg, predictionWindowMs: 60_000, maxHoldMs: 120_000 }
    const stop = startScheduler(w.ctx, live, 50)
    after(stop)
    const until = async (what: string, ok: () => Promise<boolean>) => {
      for (let i = 0; !(await ok()); i++) {
        assert.ok(i < 600, `timed out waiting for: ${what}`)
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    await until('Beta predicts on the broadcast', async () => {
      return (await w.db.select().from(schema.predictions)).length === 1
    })
    w.stub.setPrice(3100)
    await until('the market settles', async () => {
      const [m] = await w.db.select().from(schema.rounds)
      return m?.phase === 'SETTLED'
    })
    stop()
    await new Promise((r) => setTimeout(r, 200)) // let any tick in flight finish
    assert.equal((await w.db.select().from(schema.rounds)).length, 1)
    assert.equal((await w.db.select().from(schema.roundEntries)).length, 1, 'opened exactly once')
    assert.equal((await entry(w)).outcome, 'YES')
    await verifiedOk(w, (await entry(w)).id)
  })

  test('verifyEntry: an honest entry passes; each tampered claim fails its step', async () => {
    const w = await arena()
    await opened(w)
    w.stub.setPrice(3100)
    w.at(WINDOW)
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

  test('a losing trade resolves NO and earns no trader award', async () => {
    const w = await arena()
    await opened(w)
    w.stub.setPrice(2900) // stop-loss fires
    w.at(WINDOW)
    await tick(w.ctx, cfg)
    const e = await entry(w)
    assert.equal(e.outcome, 'NO')
    assert.ok(e.pnlBps! < 0)
    await verifiedOk(w, e.id)
    w.at(EPOCH)
    await tick(w.ctx, cfg)
    const awards = await w.db.select().from(schema.rewardAwards)
    assert.ok(awards.every((a) => a.category !== 'trader'))
  })
})
