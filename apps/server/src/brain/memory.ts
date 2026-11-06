/**
 * What an agent remembers: its last few accepted decisions and how they ended. Built from tables
 * we already keep (decisions, intents, round_entries), so there is nothing new to store.
 */
import { sql } from 'drizzle-orm'
import type { AppContext } from '../context'
import { queryRows } from '../db'
import { parseModelJson } from './validate'

export type MemoryRow = {
  kind: string
  raw_output: string
  created_at: string | number
  intent_state: string | null
  fail_reason: string | null
  outcome: string | null
  pnl_bps: string | number | null
}

export type Memory = {
  minutesAgo: number
  did: 'wait' | 'buy' | 'predict'
  why: string
  result: string | null
}

const clip = (s: unknown) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').slice(0, 160) : '')

/** Turn one stored decision into a line the agent can learn from. Pure, so it is easy to test. */
export function describeDecision(row: MemoryRow, nowMs: number): Memory {
  const out = parseModelJson(row.raw_output) as {
    rationale?: unknown
    predictions?: { rationale?: unknown }[]
  } | null
  const why = clip(out?.rationale ?? out?.predictions?.[0]?.rationale)
  const minutesAgo = Math.max(0, Math.round((nowMs - Number(row.created_at)) / 60_000))
  if (row.kind === 'prediction') return { minutesAgo, did: 'predict', why, result: null }
  if (row.kind !== 'trade') return { minutesAgo, did: 'wait', why, result: null }
  let result: string
  if (row.intent_state === 'FAILED')
    result = `the order failed (${clip(row.fail_reason) || 'unknown'})`
  else if (!row.outcome || row.outcome === 'PENDING') result = 'position still open'
  else if (row.outcome === 'VOID') result = 'voided, no result'
  else {
    const pnl = row.pnl_bps == null ? null : Number(row.pnl_bps) / 100
    const pnlText = pnl == null ? '' : ` (${pnl > 0 ? '+' : ''}${pnl}% after fees)`
    result = `${row.outcome === 'YES' ? 'profit' : 'no profit'}${pnlText}`
  }
  return { minutesAgo, did: 'buy', why, result }
}

export async function recentMemory(ctx: AppContext, agentId: string, limit = 5) {
  const rows = await queryRows<MemoryRow>(
    ctx.db,
    sql`select d.kind, d.raw_output, d.created_at, i.state as intent_state, i.fail_reason,
               e.outcome, e.pnl_bps
        from decisions d
        left join intents i on i.decision_id = d.id
        left join round_entries e on e.id = i.entry_id
        where d.agent_id = ${agentId} and d.accepted = true
        order by d.created_at desc
        limit ${limit}`,
  )
  const now = ctx.now()
  return rows.map((r) => describeDecision(r, now))
}
