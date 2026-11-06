/**
 * Database: Postgres everywhere.
 * - Production: DATABASE_URL=postgres://… (Neon; use the pooled connection string with sslmode).
 * - Local dev and tests: in-process PGlite (Postgres compiled to WASM), so no setup is needed.
 *   `openDb('memory://')` gives a throwaway database; a directory path persists it.
 * Pending migrations (apps/server/drizzle) are applied on open.
 */
import { mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import type { SQL } from 'drizzle-orm'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres'
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import pg from 'pg'
import * as schema from './schema'

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>
export type DbHandle = { db: Db; kind: 'postgres' | 'pglite'; close: () => Promise<void> }

const MIGRATIONS_DIR = resolve(import.meta.dirname, '../../drizzle')

export async function openDb(location: string): Promise<DbHandle> {
  if (/^postgres(ql)?:\/\//.test(location)) {
    const pool = new pg.Pool({ connectionString: location, max: 5 })
    const db = drizzlePg(pool, { schema })
    await migratePg(db, { migrationsFolder: MIGRATIONS_DIR })
    return { db: db as unknown as Db, kind: 'postgres', close: () => pool.end() }
  }
  if (location !== 'memory://') mkdirSync(location, { recursive: true })
  const client = new PGlite(location === 'memory://' ? undefined : location)
  const db = drizzlePglite(client, { schema })
  await migratePglite(db, { migrationsFolder: MIGRATIONS_DIR })
  return { db: db as unknown as Db, kind: 'pglite', close: () => client.close() }
}

/** Raw SQL returning typed rows (both drivers return `{ rows }`). */
export async function queryRows<T>(db: Db, query: SQL): Promise<T[]> {
  const result = (await db.execute(query)) as unknown as { rows: T[] }
  return result.rows
}

export { schema }
