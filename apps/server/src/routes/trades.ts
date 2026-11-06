import { desc, eq } from 'drizzle-orm'
import { Router, type Request } from 'express'
import { getAddress } from 'viem'
import { z } from 'zod'
import { ownerAuth, walletOf } from '../auth/owner-auth'
import type { AppContext } from '../context'
import { schema } from '../db'
import { closePosition } from '../execution/close'
import { executeTrade, newIntentId } from '../execution/trade'
import { handler, HttpError } from '../http'
import { tick } from '../rounds/scheduler'
import { getAgent, getOwnedAgent } from '../services/agents'

const decimal = z.string().regex(/^\d+(\.\d{1,8})?$/)
const manualBody = z
  .object({
    sizeQuote: decimal,
    entryRefPrice: decimal.optional(),
    stopPrice: decimal,
    targetPrice: decimal,
  })
  .strict()

export function tradesRouter(ctx: AppContext) {
  const r = Router()
  const auth = ownerAuth(ctx.publicClient, ctx.now)
  const id = (req: Request) => String(req.params.id)

  /** Public trade history for an agent (every commit, including failures). */
  r.get(
    '/agents/:id/intents',
    handler(async (req, res) => {
      const agent = await getAgent(ctx, id(req))
      const rows = await ctx.db
        .select()
        .from(schema.intents)
        .where(eq(schema.intents.agentId, agent.id))
        .orderBy(desc(schema.intents.createdAt))
        .limit(100)
      res.json({ intents: rows })
    }),
  )

  /**
   * MANUAL smoke-test trade (no 0G decision; labeled `model: "manual"`). Enabled on local anvil by
   * default; on Base only with ALLOW_MANUAL_TRADES=true for the first live check.
   */
  r.post(
    '/agents/:id/manual-trade',
    auth,
    handler(async (req, res) => {
      if (!ctx.allowManualTrades) throw new HttpError(403, 'manual_trades_disabled')
      const agent = await getOwnedAgent(ctx, id(req), walletOf(res))
      const body = manualBody.parse(req.body)
      let entryRefPrice = body.entryRefPrice
      if (!entryRefPrice) {
        const [asset] = (await ctx.flash?.api.search('WETH', ctx.flash.chain, 1)) ?? []
        if (!asset) throw new HttpError(503, 'price_unavailable')
        entryRefPrice = Number(asset.price).toFixed(2)
      }
      const result = await executeTrade(ctx, {
        version: 1,
        intentId: newIntentId(),
        roundId: 0,
        agentAddress: getAddress(agent.address),
        asset: 'WETH',
        side: 'long',
        entryRefPrice,
        sizeQuote: body.sizeQuote,
        orderType: 'bracket',
        stopPrice: body.stopPrice,
        targetPrice: body.targetPrice,
        rationale: 'manual smoke-test trade (no model decision)',
        zeroG: { requestId: `manual-${newIntentId()}`, model: 'manual' },
        createdAt: new Date(ctx.now()).toISOString(),
      })
      const status = result.status === 'executed' ? 201 : result.status === 'denied' ? 409 : 502
      res.status(status).json(result)
    }),
  )

  r.post(
    '/agents/:id/intents/:intentId/close',
    auth,
    handler(async (req, res) => {
      const agent = await getOwnedAgent(ctx, id(req), walletOf(res))
      const [intent] = await ctx.db
        .select()
        .from(schema.intents)
        .where(eq(schema.intents.intentId, String(req.params.intentId)))
      if (!intent || intent.agentId !== agent.id) throw new HttpError(404, 'intent_not_found')
      res.json(await closePosition(ctx, intent.intentId))
    }),
  )

  /** LOCAL TEST ONLY: move the Flash stub's price. Absent unless the stub is active. */
  const stub = ctx.flash?.stub
  if (stub) {
    r.post(
      '/dev/flash-stub/price',
      handler(async (req, res) => {
        const { priceUsd } = z.object({ priceUsd: z.number().positive() }).parse(req.body)
        stub.setPrice(priceUsd)
        res.json({ priceUsd, note: 'local Flash stub; not a real market' })
      }),
    )
  }
  /** LOCAL TEST ONLY: run one scheduler tick now (used by e2e with the timer disabled). */
  if (ctx.devTools && ctx.rounds) {
    const rounds = ctx.rounds
    r.post(
      '/dev/rounds/tick',
      handler(async (_req, res) => {
        res.json({ acted: await tick(ctx, rounds) })
      }),
    )
  }
  return r
}
