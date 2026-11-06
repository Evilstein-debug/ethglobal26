/**
 * `pnpm dev:reset`: start the local world over. Deletes the saved anvil chain and every row of the
 * local server database, Neon included, since the two only make sense together. Local chain only.
 */
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { ANVIL_STATE, isAnvilUp, ROOT } from './lib/local'

if (process.env.CHAIN_ID && process.env.CHAIN_ID !== '31337') {
  console.error(`dev:reset is for the local chain only; CHAIN_ID is ${process.env.CHAIN_ID}.`)
  process.exit(1)
}
if (await isAnvilUp()) {
  console.error('Stop `pnpm dev` first.')
  process.exit(1)
}

rmSync(ANVIL_STATE, { force: true })
rmSync(resolve(ROOT, 'apps/server/data/pglite-31337'), { recursive: true, force: true })

const url = process.env.DATABASE_URL
if (url && /^postgres(ql)?:\/\//.test(url)) {
  const pool = new pg.Pool({ connectionString: url, max: 1 })
  const { rows } = await pool.query(
    `select table_name from information_schema.tables
     where table_schema = 'public' and table_type = 'BASE TABLE'`,
  )
  if (rows.length) {
    const names = rows.map((r: { table_name: string }) => `"${r.table_name}"`).join(', ')
    await pool.query(`truncate ${names} restart identity cascade`)
  }
  await pool.end()
  console.log(`Emptied ${rows.length} tables in ${new URL(url).host}.`)
}
console.log('Local chain and database cleared. `pnpm dev` starts fresh.')
