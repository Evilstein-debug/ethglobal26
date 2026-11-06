/**
 * `pnpm seed:replay [--clear]`: add (or remove) the labeled replay rows on the leaderboards.
 * Sample data only (apps/server/fixtures/replay.json): rows show a "replay" badge, the agents have
 * no keys, and they can't trade, predict or earn. Writes to DATABASE_URL, or the local PGlite
 * directory for CHAIN_ID (stop the local server first: PGlite is single-process).
 */
import { resolve } from 'node:path'
import { parseChainId } from '@starter/shared/chains'
import { openDb } from '../apps/server/src/db'
import { clearReplay, seedReplay } from '../apps/server/src/services/replay'
import { ROOT } from './lib/local'

const location =
  process.env.DATABASE_URL ||
  resolve(ROOT, `apps/server/data/pglite-${parseChainId(process.env.CHAIN_ID)}`)
const { db, close } = await openDb(location)
if (process.argv.includes('--clear')) console.log(`Removed ${await clearReplay(db)} replay agents`)
else console.log(`Seeded ${await seedReplay(db)} replay agents (labeled "replay", sample data)`)
await close()
