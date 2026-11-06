import { Router, type Request } from 'express'
import { getAddress, parseUnits } from 'viem'
import { z } from 'zod'
import { USDC_DECIMALS } from '@starter/shared/tokens'
import { ownerAuth, walletOf } from '../auth/owner-auth'
import type { AppContext } from '../context'
import { handler } from '../http'
import { authorizeTrade } from '../policy/authorize'
import {
  balancesOf,
  createAgent,
  getAgentView,
  getOwnedAgent,
  registerAgentOnchain,
  setPaused,
  updatePolicy,
  withdraw,
} from '../services/agents'

const previewBody = z
  .object({
    amount: z.string().regex(/^\d+(\.\d{1,6})?$/),
    asset: z.string().max(10),
    roundId: z.number().int().nonnegative().default(0),
  })
  .strict()

export function agentsRouter(ctx: AppContext) {
  const r = Router()
  const auth = ownerAuth(ctx.publicClient, ctx.now)
  const id = (req: Request) => String(req.params.id)

  r.post(
    '/agents',
    auth,
    handler(async (req, res) => {
      res.status(201).json(await createAgent(ctx, walletOf(res), req.body))
    }),
  )

  r.get(
    '/agents/:id',
    handler(async (req, res) => {
      res.json(await getAgentView(ctx, id(req)))
    }),
  )

  r.patch(
    '/agents/:id/policy',
    auth,
    handler(async (req, res) => {
      await getOwnedAgent(ctx, id(req), walletOf(res))
      await updatePolicy(ctx, id(req), req.body)
      res.json(await getAgentView(ctx, id(req)))
    }),
  )

  for (const [path, paused] of [
    ['pause', true],
    ['resume', false],
  ] as const) {
    r.post(
      `/agents/:id/${path}`,
      auth,
      handler(async (req, res) => {
        await getOwnedAgent(ctx, id(req), walletOf(res))
        await setPaused(ctx, id(req), paused)
        res.json(await getAgentView(ctx, id(req)))
      }),
    )
  }

  r.post(
    '/agents/:id/register',
    auth,
    handler(async (req, res) => {
      await getOwnedAgent(ctx, id(req), walletOf(res))
      res.json({ registerTx: await registerAgentOnchain(ctx, id(req)) })
    }),
  )

  r.post(
    '/agents/:id/withdraw',
    auth,
    handler(async (req, res) => {
      const agent = await getOwnedAgent(ctx, id(req), walletOf(res))
      res.json(await withdraw(ctx, agent, req.body))
    }),
  )

  /** "Would this trade pass my limits right now?" Runs every policy rule, reserves nothing. */
  r.post(
    '/agents/:id/trade-preview',
    auth,
    handler(async (req, res) => {
      const agent = await getOwnedAgent(ctx, id(req), walletOf(res))
      const body = previewBody.parse(req.body)
      const { usdc } = await balancesOf(ctx, getAddress(agent.address))
      const result = await authorizeTrade(
        ctx.db,
        {
          agentId: agent.id,
          roundId: body.roundId,
          amount: Number(parseUnits(body.amount, USDC_DECIMALS)),
          asset: body.asset,
          ref: 'preview',
        },
        usdc,
        ctx.now(),
        { dryRun: true },
      )
      res.json(result.ok ? { allowed: true } : { allowed: false, reason: result.reason })
    }),
  )
  return r
}
