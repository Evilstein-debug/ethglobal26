import cors from 'cors'
import { sql } from 'drizzle-orm'
import express from 'express'
import type { AppContext } from './context'
import { errorHandler } from './http'
import { agentsRouter } from './routes/agents'
import { ownersRouter } from './routes/owners'

export function createApp(ctx: AppContext, corsOrigins: string[] = []) {
  const app = express()
  app.disable('x-powered-by')
  app.use(cors({ origin: corsOrigins }))
  app.use(express.json({ limit: '100kb' }))

  app.get('/health', async (_req, res) => {
    const [blockNumber, db] = await Promise.all([
      ctx.publicClient.getBlockNumber().then(String, () => null),
      ctx.db.execute(sql`select 1`).then(
        () => true,
        () => false,
      ),
    ])
    res.status(blockNumber && db ? 200 : 503).json({
      ok: Boolean(blockNumber && db),
      chainId: ctx.chain.id,
      blockNumber,
      db,
      humanVerifier: ctx.humanVerifier.method,
      contracts: ctx.contracts,
    })
  })

  app.use('/api', ownersRouter(ctx), agentsRouter(ctx))
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'not_found' })
  })
  app.use(errorHandler)
  return app
}
