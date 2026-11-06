import cors from 'cors'
import express, { type ErrorRequestHandler } from 'express'
import { chain, publicClient, rpcUrl } from './chain'
import { env } from './env'
import { listFeed, startFeed } from './feed'

// Put anything here that shouldn't run in the browser (secrets, indexing, webhooks, ...).
const app = express()
app.disable('x-powered-by')
app.use(cors({ origin: env.corsOrigins }))
app.use(express.json())

app.get('/health', async (_req, res) => {
  const blockNumber = await publicClient.getBlockNumber()
  res.json({ ok: true, chainId: chain.id, blockNumber: blockNumber.toString() })
})

app.get('/api/feed', (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 100)
  res.json({ entries: listFeed(limit) })
})

const onError: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) return next(err)
  console.error(`[server] ${req.method} ${req.path} failed:`, err)
  res.status(500).json({ error: 'Internal error' })
}
app.use(onError)

startFeed()
app.listen(env.port, (error) => {
  if (error) throw error
  console.log(
    `[server] http://localhost:${env.port} · chain ${chain.id} (${chain.name}) · rpc ${rpcUrl}`,
  )
})
