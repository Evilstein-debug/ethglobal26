/**
 * Indexes owners' manual predictions. Owners call Arena.predict from their own wallet in the
 * browser; this polls `Predicted` events (block cursor, like the starter's feed) and stores the
 * ones made by owner wallets (agent predictions are stored when the agent submits them).
 */
import { randomUUID } from 'node:crypto'
import { canonicalJson } from '@starter/shared/canonical'
import { arenaAbi } from '@starter/shared/generated'
import { predictionSchema } from '@starter/shared/schemas'
import { eq } from 'drizzle-orm'
import { getAddress, parseEventLogs } from 'viem'
import type { AppContext } from '../context'
import { schema } from '../db'

const MAX_RANGE = 1_000n

export function startPredictionIndexer(ctx: AppContext, everyMs = 3000) {
  let cursor: bigint | undefined
  let stopped = false

  async function poll() {
    const head = await ctx.publicClient.getBlockNumber()
    if (cursor === undefined || cursor > head + 1n) cursor = head > 5000n ? head - 5000n : 0n
    if (cursor > head) return
    const toBlock = head - cursor >= MAX_RANGE ? cursor + MAX_RANGE - 1n : head
    const logs = await ctx.publicClient.getLogs({
      address: ctx.contracts.arena,
      fromBlock: cursor,
      toBlock,
    })
    for (const log of parseEventLogs({ abi: arenaAbi, eventName: 'Predicted', logs })) {
      const predictor = log.args.predictor.toLowerCase()
      const [owner] = await ctx.db
        .select()
        .from(schema.owners)
        .where(eq(schema.owners.wallet, predictor))
      if (!owner) continue // agent predictions are recorded by the agent pipeline
      const [entry] = await ctx.db
        .select()
        .from(schema.roundEntries)
        .where(eq(schema.roundEntries.onchainEntryId, Number(log.args.entryId)))
      if (!entry) continue
      const prediction = predictionSchema.parse({
        version: 1,
        predictionId: randomUUID(),
        roundId: entry.roundId,
        entryId: Number(log.args.entryId),
        predictorKind: 'owner',
        predictor: getAddress(predictor),
        side: log.args.yes ? 'YES' : 'NO',
        probYesBps: log.args.probYesBps,
        rationale: 'manual pick',
        zeroG: null,
        createdAt: new Date(ctx.now()).toISOString(),
      })
      await ctx.db
        .insert(schema.predictions)
        .values({
          predictionId: prediction.predictionId,
          roundId: entry.roundId,
          entryId: entry.id,
          predictorKind: 'owner',
          predictorAddress: predictor,
          side: prediction.side,
          probYesBps: prediction.probYesBps,
          canonicalJson: canonicalJson(prediction),
          predictTx: log.transactionHash,
        })
        .onConflictDoNothing()
    }
    cursor = toBlock + 1n
  }

  const loop = async () => {
    while (!stopped) {
      try {
        await poll()
      } catch (err) {
        console.warn('[indexer] poll failed:', err instanceof Error ? err.message : err)
      }
      await new Promise((r) => setTimeout(r, everyMs))
    }
  }
  void loop()
  return () => {
    stopped = true
  }
}
