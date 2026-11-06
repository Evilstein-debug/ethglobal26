import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDb, schema } from './index'

function freshDb() {
  return openDb(':memory:')
}

const owner = {
  wallet: '0xaaaa000000000000000000000000000000000001',
  worldNullifierHash: '0xnullifier1',
  humanId: '0xhuman1',
  verifiedAt: Date.now(),
}

test('migrations create every table', () => {
  const db = freshDb()
  const tables = db.$client
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE '\\_\\_%' ESCAPE '\\'`,
    )
    .all()
    .map((r) => (r as { name: string }).name)
  for (const name of [
    'owners',
    'agents',
    'policies',
    'spend_ledger',
    'rounds',
    'round_entries',
    'intents',
    'predictions',
    'decisions',
    'agent_stats',
    'reward_epochs',
    'reward_awards',
  ]) {
    assert.ok(tables.includes(name), `missing table ${name}`)
  }
})

test('one World nullifier = one owner account', () => {
  const db = freshDb()
  db.insert(schema.owners).values(owner).run()
  assert.throws(
    () =>
      db
        .insert(schema.owners)
        .values({
          ...owner,
          wallet: '0xbbbb000000000000000000000000000000000002',
          humanId: '0xother',
        })
        .run(),
    /UNIQUE constraint failed: owners.world_nullifier_hash/,
  )
})

test('foreign keys are enforced', () => {
  const db = freshDb()
  assert.throws(
    () =>
      db
        .insert(schema.agents)
        .values({
          id: 'a1',
          ownerWallet: '0xnobody',
          name: 'Alpha',
          mode: 'trade',
          address: '0x1',
          encKey: 'x',
        })
        .run(),
    /FOREIGN KEY constraint failed/,
  )
})

test('at most one reward per human per epoch', () => {
  const db = freshDb()
  db.insert(schema.owners).values(owner).run()
  db.insert(schema.agents)
    .values({
      id: 'a1',
      ownerWallet: owner.wallet,
      name: 'Alpha',
      mode: 'both',
      address: '0x1',
      encKey: 'x',
    })
    .run()
  db.insert(schema.rewardEpochs).values({ id: 1, startsAt: 0, endsAt: 1, budget: 5_000_000 }).run()
  const award = {
    epochId: 1,
    humanId: owner.humanId,
    ownerWallet: owner.wallet,
    agentId: 'a1',
    rank: 1,
    amount: 1_000_000,
  }
  db.insert(schema.rewardAwards)
    .values({ ...award, category: 'trader' })
    .run()
  assert.throws(
    () =>
      db
        .insert(schema.rewardAwards)
        .values({ ...award, category: 'predictor', rank: 1 })
        .run(),
    /UNIQUE constraint failed/,
  )
})
