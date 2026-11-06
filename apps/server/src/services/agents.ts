/** Agent lifecycle: create (key + policy + onchain registration), signer, balances, withdraw. */
import { randomUUID } from 'node:crypto'
import { USDC_DECIMALS } from '@starter/shared/tokens'
import { and, count, eq, inArray, isNotNull, sql } from 'drizzle-orm'
import {
  erc20Abi,
  encodeFunctionData,
  formatUnits,
  getAddress,
  parseUnits,
  type Address,
  type Hex,
} from 'viem'
import { z } from 'zod'
import type { AppContext } from '../context'
import { queryRows, schema } from '../db'
import { HttpError } from '../http'
import { createAgentKey } from '../wallets/agent-keys'
import { AgentSigner } from '../wallets/signer'

export const MAX_AGENTS_PER_OWNER = 5
/** Hackathon safety ceiling on any single cap (USDC). */
const MAX_CAP_USDC = 1000

const usdcAmount = z
  .string()
  .regex(/^\d+(\.\d{1,6})?$/, 'USDC amount like "5" or "2.50"')
  .transform((v) => Number(parseUnits(v, USDC_DECIMALS)))
  .refine((v) => v <= MAX_CAP_USDC * 10 ** USDC_DECIMALS, `at most ${MAX_CAP_USDC} USDC`)

export const policyInput = z
  .object({
    perTradeCap: usdcAmount,
    roundTradeCap: usdcAmount,
    dailyCap: usdcAmount,
    predictionsPerRound: z.number().int().min(0).max(50).default(10),
  })
  .strict()
  .refine((p) => p.perTradeCap <= p.roundTradeCap && p.roundTradeCap <= p.dailyCap, {
    message: 'caps must satisfy perTrade ≤ perRound ≤ daily',
  })

export const createAgentInput = z
  .object({
    name: z.string().trim().min(1).max(40),
    mode: z.enum(['trade', 'predict', 'both']),
    policy: policyInput,
  })
  .strict()

export const withdrawInput = z
  .object({
    asset: z.enum(['USDC', 'ETH', 'WETH']),
    amount: z.string().regex(/^\d+(\.\d{1,18})?$/),
  })
  .strict()

type AgentRow = typeof schema.agents.$inferSelect

const fmtUsdc = (v: number | bigint) => formatUnits(BigInt(v), USDC_DECIMALS)

export async function getAgent(ctx: AppContext, id: string) {
  const [row] = await ctx.db.select().from(schema.agents).where(eq(schema.agents.id, id))
  if (!row) throw new HttpError(404, 'agent_not_found')
  return row
}

export async function getOwnedAgent(ctx: AppContext, id: string, wallet: Address) {
  const agent = await getAgent(ctx, id)
  if (agent.ownerWallet !== wallet.toLowerCase()) throw new HttpError(403, 'not_agent_owner')
  return agent
}

export async function createAgent(ctx: AppContext, ownerWallet: Address, body: unknown) {
  const input = createAgentInput.parse(body)
  const wallet = ownerWallet.toLowerCase()
  const [owner] = await ctx.db.select().from(schema.owners).where(eq(schema.owners.wallet, wallet))
  if (!owner) throw new HttpError(403, 'not_verified')
  const [existing] = await ctx.db
    .select({ n: count() })
    .from(schema.agents)
    .where(eq(schema.agents.ownerWallet, wallet))
  if ((existing?.n ?? 0) >= MAX_AGENTS_PER_OWNER) throw new HttpError(409, 'agent_limit_reached')

  const id = randomUUID()
  const { address, encKey } = createAgentKey(ctx.keyBox, id)
  await ctx.db.transaction(async (tx) => {
    await tx.insert(schema.agents).values({
      id,
      ownerWallet: wallet,
      name: input.name,
      mode: input.mode,
      address: address.toLowerCase(),
      encKey,
    })
    await tx.insert(schema.policies).values({ agentId: id, ...input.policy })
  })
  await registerAgentOnchain(ctx, id)
  return getAgentView(ctx, id)
}

/** Link the agent wallet to its owner's human in Arena. Safe to retry. */
export async function registerAgentOnchain(ctx: AppContext, id: string) {
  const agent = await getAgent(ctx, id)
  if (agent.registerTx) return agent.registerTx
  const [owner] = await ctx.db
    .select()
    .from(schema.owners)
    .where(eq(schema.owners.wallet, agent.ownerWallet))
  if (!owner) throw new HttpError(403, 'not_verified')
  try {
    const hash = await ctx.arena.registerAgent(getAddress(agent.address), owner.humanId as Hex)
    await ctx.db.update(schema.agents).set({ registerTx: hash }).where(eq(schema.agents.id, id))
    return hash
  } catch (err) {
    console.error(`[agents] registerAgent failed for ${id}:`, err)
    throw new HttpError(502, 'onchain_registration_failed', {
      agentId: id,
      retry: `POST /api/agents/${id}/register`,
    })
  }
}

export async function balancesOf(ctx: AppContext, address: Address) {
  const { usdc, weth } = ctx.contracts
  const read = (token: Address) =>
    ctx.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [address],
    })
  const [usdcBal, ethBal, wethBal] = await Promise.all([
    read(usdc),
    ctx.publicClient.getBalance({ address }),
    weth ? read(weth) : Promise.resolve(undefined),
  ])
  return { usdc: usdcBal, eth: ethBal, weth: wethBal }
}

export async function getAgentView(ctx: AppContext, id: string) {
  const agent = await getAgent(ctx, id)
  const [policy] = await ctx.db
    .select()
    .from(schema.policies)
    .where(eq(schema.policies.agentId, id))
  const [open] = await ctx.db
    .select({ total: sql<string>`coalesce(sum(${schema.spendLedger.amount}), 0)` })
    .from(schema.spendLedger)
    .where(and(eq(schema.spendLedger.agentId, id), eq(schema.spendLedger.status, 'reserved')))
  let balances: Record<string, string> | null = null
  try {
    const b = await balancesOf(ctx, getAddress(agent.address))
    balances = {
      usdc: fmtUsdc(b.usdc),
      eth: formatUnits(b.eth, 18),
      ...(b.weth !== undefined ? { weth: formatUnits(b.weth, 18) } : {}),
    }
  } catch (err) {
    console.warn(
      `[agents] balance read failed for ${id}:`,
      err instanceof Error ? err.message : err,
    )
  }
  return publicAgent(agent, policy, { balances, reservedUsdc: fmtUsdc(Number(open?.total ?? 0)) })
}

function publicAgent(
  agent: AgentRow,
  policy: typeof schema.policies.$inferSelect | undefined,
  extra: { balances: Record<string, string> | null; reservedUsdc: string },
) {
  // Never expose encKey.
  return {
    id: agent.id,
    name: agent.name,
    mode: agent.mode,
    address: getAddress(agent.address),
    owner: getAddress(agent.ownerWallet),
    status: agent.status,
    registerTx: agent.registerTx,
    createdAt: agent.createdAt,
    policy: policy && {
      perTradeCap: fmtUsdc(policy.perTradeCap),
      roundTradeCap: fmtUsdc(policy.roundTradeCap),
      dailyCap: fmtUsdc(policy.dailyCap),
      predictionsPerRound: policy.predictionsPerRound,
      tokenAllowlist: JSON.parse(policy.tokenAllowlist) as string[],
      paused: policy.paused,
    },
    ...extra,
  }
}

export async function listOwnerAgents(ctx: AppContext, wallet: string) {
  const rows = await ctx.db
    .select({ id: schema.agents.id })
    .from(schema.agents)
    .where(eq(schema.agents.ownerWallet, wallet.toLowerCase()))
  return Promise.all(rows.map((r) => getAgentView(ctx, r.id)))
}

export async function updatePolicy(ctx: AppContext, id: string, body: unknown) {
  const policy = policyInput.parse(body)
  await ctx.db
    .update(schema.policies)
    .set({ ...policy, updatedAt: ctx.now() })
    .where(eq(schema.policies.agentId, id))
}

export async function setPaused(ctx: AppContext, id: string, paused: boolean) {
  await ctx.db
    .update(schema.policies)
    .set({ paused, updatedAt: ctx.now() })
    .where(eq(schema.policies.agentId, id))
  await ctx.db
    .update(schema.agents)
    .set({ status: paused ? 'paused' : 'active' })
    .where(eq(schema.agents.id, id))
}

export function agentSigner(ctx: AppContext, agent: AgentRow) {
  const privateKey = ctx.keyBox.open(agent.encKey, agent.id)
  return new AgentSigner({
    privateKey,
    chain: ctx.chain,
    rpcUrl: ctx.rpcUrl,
    pollingInterval: ctx.pollingInterval,
    egress: {
      chainId: ctx.chain.id,
      owner: getAddress(agent.ownerWallet),
      tradeLog: ctx.contracts.tradeLog,
      arena: ctx.contracts.arena,
      tokens: [ctx.contracts.usdc, ...(ctx.contracts.weth ? [ctx.contracts.weth] : [])],
      flashSpenders: ctx.flash?.approvalSpenders ?? [],
      flashTypedDataContracts: ctx.flash?.typedDataContracts ?? [],
    },
    isPaused: async () => {
      const [p] = await ctx.db
        .select({ paused: schema.policies.paused })
        .from(schema.policies)
        .where(eq(schema.policies.agentId, agent.id))
      return p?.paused ?? true
    },
  })
}

/** Withdraw to the owner. Never touches budget reserved for an in-flight trade or a live bracket. */
export async function withdraw(ctx: AppContext, agent: AgentRow, body: unknown) {
  const input = withdrawInput.parse(body)
  const address = getAddress(agent.address)
  const owner = getAddress(agent.ownerWallet)
  const balances = await balancesOf(ctx, address)
  const signer = agentSigner(ctx, agent)
  let hash: Hex

  if (input.asset === 'ETH') {
    const amount = parseUnits(input.amount, 18)
    if (amount <= 0n || amount > balances.eth) throw new HttpError(400, 'insufficient_balance')
    hash = await signer.sendTransaction({ to: owner, value: amount })
  } else {
    const token = input.asset === 'USDC' ? ctx.contracts.usdc : ctx.contracts.weth
    if (!token) throw new HttpError(400, 'asset_unavailable_on_chain')
    const amount = parseUnits(input.amount, input.asset === 'USDC' ? USDC_DECIMALS : 18)
    const balance = input.asset === 'USDC' ? balances.usdc : (balances.weth ?? 0n)
    if (amount <= 0n || amount > balance) throw new HttpError(400, 'insufficient_balance')
    if (input.asset === 'USDC') {
      const [open] = await queryRows<{ total: string | null }>(
        ctx.db,
        sql`select sum(amount) as total from spend_ledger where agent_id = ${agent.id} and status = 'reserved'`,
      )
      if (balance - amount < BigInt(open?.total ?? 0))
        throw new HttpError(409, 'funds_reserved_for_trade')
    } else {
      const live = await ctx.db
        .select({ n: count() })
        .from(schema.intents)
        .where(
          and(
            eq(schema.intents.agentId, agent.id),
            inArray(schema.intents.state, ['EXECUTING', 'EXECUTED']),
            isNotNull(schema.intents.flashBracketOrderId),
          ),
        )
      // A live bracket sells WETH from this wallet when it fires; moving it would break the exit.
      if ((live[0]?.n ?? 0) > 0) throw new HttpError(409, 'position_open')
    }
    hash = await signer.sendTransaction({
      to: token,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [owner, amount] }),
    })
  }
  const receipt = await ctx.publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new HttpError(502, 'withdraw_reverted', { hash })
  return { hash }
}
