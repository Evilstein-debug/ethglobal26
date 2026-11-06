/**
 * The agents' live status and public activity log, shown in the Live tab. Writers call
 * `setStatus` as they move between steps; identical repeats update the row but add no log line,
 * so an idle agent doesn't fill the feed.
 */
import { eq } from 'drizzle-orm'
import type { AppContext } from '../context'
import { schema } from '../db'

export type AgentState = (typeof schema.AGENT_STATES)[number]
type LogFields = { rationale?: string; decisionId?: string; entryId?: number; detail?: string }

export async function logActivity(
  ctx: AppContext,
  agentId: string,
  state: (typeof schema.agentActivity.$inferInsert)['state'],
  message: string,
  fields: LogFields = {},
) {
  await ctx.db.insert(schema.agentActivity).values({
    agentId,
    state,
    message: message.slice(0, 500),
    rationale: fields.rationale?.slice(0, 500) ?? null,
    detail: fields.detail?.slice(0, 4000) ?? null,
    decisionId: fields.decisionId ?? null,
    entryId: fields.entryId ?? null,
    createdAt: ctx.now(),
  })
}

export async function setStatus(
  ctx: AppContext,
  agentId: string,
  state: AgentState,
  detail: string,
  opts: LogFields & { nextThinkAt?: number; silent?: boolean } = {},
) {
  const { nextThinkAt, silent, ...fields } = opts
  const [current] = await ctx.db
    .select()
    .from(schema.agentStatus)
    .where(eq(schema.agentStatus.agentId, agentId))
  const row = {
    state,
    detail: detail.slice(0, 500),
    nextThinkAt: nextThinkAt ?? current?.nextThinkAt ?? 0,
    updatedAt: ctx.now(),
  }
  await ctx.db
    .insert(schema.agentStatus)
    .values({ agentId, ...row })
    .onConflictDoUpdate({ target: schema.agentStatus.agentId, set: row })
  // `silent`: update the status card only. The caller logs the feed line itself, so a repeat
  // (the same "decided to wait" with new reasoning) is never swallowed by the dedup below.
  if (!silent && (current?.state !== state || current.detail !== row.detail)) {
    await logActivity(ctx, agentId, state, detail, fields)
  }
}

/** Think on the next tick, whatever the schedule says: how a broadcast reaches predictors. */
export async function wakeAgent(ctx: AppContext, agentId: string) {
  await ctx.db
    .insert(schema.agentStatus)
    .values({
      agentId,
      state: 'idle',
      detail: 'Starting up',
      nextThinkAt: 0,
      updatedAt: ctx.now(),
    })
    .onConflictDoUpdate({ target: schema.agentStatus.agentId, set: { nextThinkAt: 0 } })
}
