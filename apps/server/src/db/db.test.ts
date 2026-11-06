import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sql } from 'drizzle-orm'
import { queryRows, schema } from './index'
import { errorText, freshDb } from './testing'

async function rejectsWith(promise: Promise<unknown>, pattern: RegExp) {
  await assert.rejects(promise, (err: unknown) => {
    assert.match(errorText(err), pattern)
    return true
  })
}

const owner = {
  wallet: '0xaaaa000000000000000000000000000000000001',
  worldNullifierHash: '0xnullifier1',
  humanId: '0xhuman1',
  verifiedAt: Date.now(),
}
const agent = {
  id: 'a1',
  ownerWallet: owner.wallet,
  name: 'Alpha',
  mode: 'both' as const,
  address: '0x1',
  encKey: 'x',
}

test('migrations create every table', async () => {
  const db = await freshDb()
  const rows = await queryRows<{ table_name: string }>(
    db,
    sql`select table_name from information_schema.tables where table_schema = 'public'`,
  )
  const tables = rows.map((r) => r.table_name)
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

test('one World nullifier = one owner account', async () => {
  const db = await freshDb()
  await db.insert(schema.owners).values(owner)
  await rejectsWith(
    db.insert(schema.owners).values({ ...owner, wallet: '0xbbbb', humanId: '0xother' }),
    /duplicate key value violates unique constraint "owners_world_nullifier_hash_unique"/,
  )
})

test('foreign keys are enforced', async () => {
  const db = await freshDb()
  await rejectsWith(
    db.insert(schema.agents).values({ ...agent, ownerWallet: '0xnobody' }),
    /violates foreign key constraint/,
  )
})

test('at most one reward per human per epoch', async () => {
  const db = await freshDb()
  await db.insert(schema.owners).values(owner)
  await db.insert(schema.agents).values(agent)
  await db.insert(schema.rewardEpochs).values({ id: 1, startsAt: 0, endsAt: 1, budget: 5_000_000 })
  const award = {
    epochId: 1,
    humanId: owner.humanId,
    ownerWallet: owner.wallet,
    agentId: 'a1',
    rank: 1,
    amount: 1_000_000,
  }
  await db.insert(schema.rewardAwards).values({ ...award, category: 'trader' })
  await rejectsWith(
    db.insert(schema.rewardAwards).values({ ...award, category: 'predictor' }),
    /duplicate key value violates unique constraint "awards_epoch_human_uq"/,
  )
})

test('bigint money and time columns round-trip as numbers', async () => {
  const db = await freshDb()
  await db.insert(schema.owners).values(owner)
  const [row] = await db.select().from(schema.owners)
  assert.equal(typeof row!.verifiedAt, 'number')
  assert.equal(row!.verifiedAt, owner.verifiedAt)
  assert.equal(typeof row!.createdAt, 'number')
})
