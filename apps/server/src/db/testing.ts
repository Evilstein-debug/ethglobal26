/**
 * Test helpers. Default: a fresh in-memory PGlite per call. With TEST_DATABASE_URL (localhost
 * only) every call wipes and re-migrates that real Postgres database instead, which exercises
 * the node-postgres driver used in production.
 */
import { after } from 'node:test'
import { sql } from 'drizzle-orm'
import { openDb, schema, type Db, type DbHandle } from './index'

const TEST_URL = process.env.TEST_DATABASE_URL
if (TEST_URL && !/@(localhost|127\.0\.0\.1)(:\d+)?\//.test(TEST_URL)) {
  throw new Error('TEST_DATABASE_URL must point at localhost: tests drop the public schema')
}

const handles: DbHandle[] = []
after(async () => {
  await Promise.all(handles.splice(0).map((h) => h.close()))
})

export async function freshDb(): Promise<Db> {
  if (TEST_URL) {
    for (const h of handles.splice(0)) await h.close()
    const reset = await openDb(TEST_URL)
    await reset.db.execute(
      sql`drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public`,
    )
    await reset.close()
  }
  const handle = await openDb(TEST_URL ?? 'memory://')
  handles.push(handle)
  return handle.db
}

/** Drizzle wraps driver errors; flatten the cause chain for matching. */
export function errorText(err: unknown): string {
  let text = ''
  for (
    let e = err as { message?: string; cause?: unknown } | undefined;
    e;
    e = e.cause as typeof e
  ) {
    text += ` ${e.message ?? ''}`
  }
  return text
}

let seq = 0
/** Insert a verified owner with one agent + policy. Returns ids for assertions. */
export async function seedAgent(
  db: Db,
  opts: {
    human?: string
    mode?: 'trade' | 'predict' | 'both'
    perTradeCap?: number
    roundTradeCap?: number
    dailyCap?: number
    predictionsPerRound?: number
  } = {},
) {
  const n = ++seq
  const human = opts.human ?? `human-${n}`
  const wallet = `0x${human
    .replace(/[^0-9a-f]/gi, '')
    .padEnd(8, '0')
    .slice(0, 8)}${String(n).padStart(32, '0')}`
  const existing = await db.select().from(schema.owners)
  const owner = existing.find((o) => o.humanId === `0x${human}`)
  const ownerWallet = owner?.wallet ?? wallet
  if (!owner) {
    await db.insert(schema.owners).values({
      wallet: ownerWallet,
      worldNullifierHash: `nullifier-${human}`,
      humanId: `0x${human}`,
      verifiedAt: Date.now(),
    })
  }
  const agentId = `agent-${n}`
  await db.insert(schema.agents).values({
    id: agentId,
    ownerWallet,
    name: `Agent ${n}`,
    mode: opts.mode ?? 'both',
    address: `0x${String(n).padStart(40, '0')}`,
    encKey: 'sealed',
  })
  await db.insert(schema.policies).values({
    agentId,
    perTradeCap: opts.perTradeCap ?? 5_000_000,
    roundTradeCap: opts.roundTradeCap ?? 10_000_000,
    dailyCap: opts.dailyCap ?? 20_000_000,
    predictionsPerRound: opts.predictionsPerRound ?? 10,
  })
  return { agentId, ownerWallet, humanId: `0x${human}` }
}

export { schema }
