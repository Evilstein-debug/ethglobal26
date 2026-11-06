/**
 * Labeled replay rows for the leaderboards (fixtures/replay.json): sample data, never presented
 * as real. Each row is a separate paused agent with no private key and `agent_stats.replay = true`.
 * The scheduler only runs active agents and rewards come from real entries, so these agents can't
 * trade, predict or earn. Idempotent; `clearReplay` removes them all.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { eq, inArray, like } from 'drizzle-orm'
import { keccak256, toBytes } from 'viem'
import { schema, type Db } from '../db'

type Stats = { name: string; rounds: number; wins: number; losses: number; voids: number }
type Fixture = {
  traders: (Stats & { pnlBpsTotal: number })[]
  predictors: (Stats & { brierSum: number; brierCount: number })[]
}

const REPLAY_PREFIX = 'replay:'
const fixturePath = resolve(import.meta.dirname, '../../fixtures/replay.json')
/** An address nobody holds a key for, stable across runs. */
const replayAddress = (label: string) => `0x${keccak256(toBytes(label)).slice(-40)}`

export async function seedReplay(db: Db, now = Date.now()) {
  const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as Fixture
  const rows = [
    ...fixture.traders.map((t) => ({ ...t, role: 'trader' as const })),
    ...fixture.predictors.map((p) => ({ ...p, role: 'predictor' as const })),
  ]
  for (const row of rows) {
    const id = `${REPLAY_PREFIX}${row.name}`
    const ownerWallet = replayAddress(`agentarena-replay-owner:${row.name}`)
    await db
      .insert(schema.owners)
      .values({
        wallet: ownerWallet,
        worldNullifierHash: id,
        humanId: keccak256(toBytes(id)),
        verifiedAt: now,
        verifyMethod: 'dev',
      })
      .onConflictDoNothing()
    await db
      .insert(schema.agents)
      .values({
        id,
        ownerWallet,
        name: row.name,
        mode: row.role === 'trader' ? 'trade' : 'predict',
        address: replayAddress(`agentarena-replay-agent:${row.name}`),
        encKey: 'replay-no-key',
        status: 'paused',
      })
      .onConflictDoNothing()
    await db
      .insert(schema.policies)
      .values({ agentId: id, perTradeCap: 0, roundTradeCap: 0, dailyCap: 0, paused: true })
      .onConflictDoNothing()
    await db
      .insert(schema.agentStats)
      .values({
        agentId: id,
        role: row.role,
        replay: true,
        rounds: row.rounds,
        wins: row.wins,
        losses: row.losses,
        voids: row.voids,
        pnlBpsTotal: row.role === 'trader' ? row.pnlBpsTotal : 0,
        brierSum: row.role === 'predictor' ? row.brierSum : 0,
        brierCount: row.role === 'predictor' ? row.brierCount : 0,
      })
      .onConflictDoNothing()
  }
  return rows.length
}

export async function clearReplay(db: Db) {
  const agents = await db
    .select({ id: schema.agents.id, owner: schema.agents.ownerWallet })
    .from(schema.agents)
    .where(like(schema.agents.id, `${REPLAY_PREFIX}%`))
  if (!agents.length) return 0
  const ids = agents.map((a) => a.id)
  await db.delete(schema.agentStats).where(inArray(schema.agentStats.agentId, ids))
  await db.delete(schema.policies).where(inArray(schema.policies.agentId, ids))
  await db.delete(schema.agents).where(inArray(schema.agents.id, ids))
  for (const a of agents) await db.delete(schema.owners).where(eq(schema.owners.wallet, a.owner))
  return ids.length
}
