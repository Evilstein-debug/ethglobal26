import { eq } from 'drizzle-orm'
import { Router } from 'express'
import { getAddress, type Hex } from 'viem'
import { z } from 'zod'
import { humanIdOf } from '../auth/human'
import { ownerAuth, walletOf } from '../auth/owner-auth'
import type { AppContext } from '../context'
import { schema } from '../db'
import { handler, HttpError } from '../http'
import { listOwnerAgents } from '../services/agents'

const verifyBody = z.object({ proof: z.unknown() }).strict()

export function ownersRouter(ctx: AppContext) {
  const r = Router()
  const auth = ownerAuth(ctx.publicClient, ctx.now)

  /**
   * Prove you're a unique human (World ID; 'dev' on local anvil only). One human, one account:
   * a nullifier already linked to another wallet is rejected.
   */
  r.post(
    '/owners/verify',
    auth,
    handler(async (req, res) => {
      const wallet = walletOf(res).toLowerCase()
      const { proof } = verifyBody.parse(req.body)
      const [existing] = await ctx.db
        .select()
        .from(schema.owners)
        .where(eq(schema.owners.wallet, wallet))
      if (existing) throw new HttpError(409, 'already_verified')

      const check = await ctx.humanVerifier.verify(proof, wallet)
      if (!check.ok) throw new HttpError(400, check.reason)
      const [taken] = await ctx.db
        .select()
        .from(schema.owners)
        .where(eq(schema.owners.worldNullifierHash, check.nullifierHash))
      if (taken)
        throw new HttpError(409, 'human_already_registered', {
          message: 'This person already has an account',
        })

      const humanId = humanIdOf(check.nullifierHash)
      await ctx.db.insert(schema.owners).values({
        wallet,
        worldNullifierHash: check.nullifierHash,
        humanId,
        verifiedAt: ctx.now(),
        verifyMethod: check.method,
      })
      const registerTx = await ctx.arena.registerOwner(getAddress(wallet), humanId as Hex)
      await ctx.db.update(schema.owners).set({ registerTx }).where(eq(schema.owners.wallet, wallet))
      res
        .status(201)
        .json({ wallet: getAddress(wallet), humanId, method: check.method, registerTx })
    }),
  )

  /** What the browser needs to start IDKit (public values only) and how owners verify here. */
  r.get('/world/config', (_req, res) => {
    const w = ctx.world
    res.json({
      method: ctx.humanVerifier.method,
      ...(w
        ? { app_id: w.appId, rp_id: w.rpId, action: w.action, environment: w.environment }
        : {}),
    })
  })

  /** RP signature for one IDKit request, generated server-side (the signing key stays here). */
  r.post('/world/rp-signature', (_req, res) => {
    if (!ctx.world) {
      res.status(404).json({ error: 'world_not_configured' })
      return
    }
    res.json(ctx.world.sign())
  })

  r.get(
    '/owners/:wallet',
    handler(async (req, res) => {
      const wallet = String(req.params.wallet).toLowerCase()
      const [owner] = await ctx.db
        .select()
        .from(schema.owners)
        .where(eq(schema.owners.wallet, wallet))
      res.json({
        wallet,
        verified: Boolean(owner),
        ...(owner && {
          humanId: owner.humanId,
          method: owner.verifyMethod,
          verifiedAt: owner.verifiedAt,
          registerTx: owner.registerTx,
        }),
        agents: owner ? await listOwnerAgents(ctx, wallet) : [],
      })
    }),
  )
  return r
}
