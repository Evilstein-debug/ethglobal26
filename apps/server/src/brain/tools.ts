/**
 * The tools an agent may ask for while it thinks. All are READ-ONLY: they fetch information and
 * can never sign, spend or change anything. The model names a tool and arguments in JSON; code
 * checks both here, runs the tool, and hands back a capped JSON result that the model must treat
 * as untrusted data (headlines in particular).
 */
import { z } from 'zod'
import type { AppContext } from '../context'
import { summarizeCandles } from './candles'
import { recentMemory } from './memory'

export const TOOL_NAMES = ['get_market', 'get_candles', 'get_news', 'get_my_history'] as const
export type ToolName = (typeof TOOL_NAMES)[number]

const noArgs = z.object({}).passthrough()
const historyArgs = z.object({ limit: z.number().int().min(1).max(10).optional() }).passthrough()
const SCHEMAS: Record<ToolName, z.ZodType> = {
  get_market: noArgs,
  get_candles: noArgs,
  get_news: noArgs,
  get_my_history: historyArgs,
}

/** Longest tool result handed back to the model, and kept for the feed. */
export const MAX_RESULT_CHARS = 3000

export const isToolName = (name: unknown): name is ToolName =>
  typeof name === 'string' && (TOOL_NAMES as readonly string[]).includes(name)

/** Flash's 24h numbers for the asset; null when Flash doesn't report them (e.g. the local stub). */
export function statsOf(asset?: {
  priceChange24h?: string
  volume24h?: string
  liquidity?: string
}) {
  const change = Number(asset?.priceChange24h)
  if (!asset || asset.priceChange24h === undefined || !Number.isFinite(change)) return null
  return {
    change24hPct: Math.round(change * 10_000) / 100,
    volume24hUsd: Math.round(Number(asset.volume24h)) || null,
    liquidityUsd: Math.round(Number(asset.liquidity)) || null,
  }
}

async function run(ctx: AppContext, agentId: string, name: ToolName, args: z.infer<z.ZodType>) {
  switch (name) {
    case 'get_market': {
      if (!ctx.flash) return { available: false, reason: 'no market source on this server' }
      const [asset] = await ctx.flash.api.search('WETH', ctx.flash.chain, 1)
      if (!asset) return { available: false, reason: 'WETH not found' }
      return {
        asset: 'WETH',
        priceUsd: Number(asset.price),
        source: ctx.flash.stub ? 'local stub price' : 'Flash /search',
        stats24h: statsOf(asset),
      }
    }
    case 'get_candles': {
      if (!ctx.readCandles) {
        return { available: false, reason: 'no candle source on this server' }
      }
      return summarizeCandles(await ctx.readCandles()) ?? { available: false, reason: 'no data' }
    }
    case 'get_news': {
      const news = await ctx.readNews()
      return { label: news.label, headlines: news.items }
    }
    case 'get_my_history': {
      const recent = await recentMemory(ctx, agentId, (args as { limit?: number }).limit ?? 5)
      return { recentDecisions: recent }
    }
  }
}

export type ToolOutcome = { ok: true; result: unknown; text: string } | { ok: false; error: string }

/** Check the model's request, run the tool, and cap what comes back. Never throws. */
export async function runTool(
  ctx: AppContext,
  agentId: string,
  name: unknown,
  args: unknown,
): Promise<ToolOutcome> {
  if (!isToolName(name)) return { ok: false, error: 'unknown_tool' }
  const parsed = SCHEMAS[name].safeParse(args ?? {})
  if (!parsed.success) return { ok: false, error: 'bad_args' }
  try {
    const result = await run(ctx, agentId, name, parsed.data)
    return { ok: true, result, text: JSON.stringify(result).slice(0, MAX_RESULT_CHARS) }
  } catch (err) {
    return { ok: false, error: `tool_failed: ${err instanceof Error ? err.message : String(err)}` }
  }
}
