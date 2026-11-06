import cors from 'cors'
import express, { type ErrorRequestHandler } from 'express'
import { chain, publicClient, rpcUrl } from './chain'
import { sql } from 'drizzle-orm'
import { openDb } from './db'
import { env } from './env'

// Anything that must not run in the browser lives here: agent keys, policy engine, 0G and Flash
// calls, the round scheduler and resolver. Routes are added phase by phase (see CLAUDE.md §8).
const { db, kind: dbKind } = await openDb(env.databaseUrl)

const app = express()
app.disable('x-powered-by')
app.use(cors({ origin: env.corsOrigins }))
app.use(express.json())

app.get('/health', async (_req, res) => {
  const blockNumber = await publicClient.getBlockNumber()
  const dbOk = await db.execute(sql`select 1`).then(
    () => true,
    () => false,
  )
  res.json({
    ok: true,
    chainId: chain.id,
    blockNumber: blockNumber.toString(),
    db: dbOk,
  })
})

const onError: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err)
  console.error(`[server] ${req.method} ${req.path} failed:`, err)
  res.status(500).json({ error: 'Internal error' })
}
app.use(onError)

app.listen(env.port, (error) => {
  if (error) throw error
  console.log(
    `[server] http://localhost:${env.port} · chain ${chain.id} (${chain.name}) · rpc ${rpcUrl} · db ${dbKind}`,
  )
})
