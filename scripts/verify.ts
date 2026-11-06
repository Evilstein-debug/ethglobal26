/**
 * `pnpm verify <entryId>`: re-derive one market's entry yourself. Fetches the claims from the server,
 * then checks them against the chain (packages/shared/src/verify.ts, the same checks as the entry
 * page) and re-verifies each 0G decision's TEE signature with the 0G SDK. Prints PASS / FAIL / SKIP
 * per step; exits 1 if anything fails. Read-only: it signs and sends nothing.
 *
 *   SERVER_URL  the AgentArena server (default http://localhost:8787)
 *   RPC_URL     RPC for the server's chain (default: that chain's public RPC)
 *   ZG_RPC_URL  0G chain RPC for TEE checks (default https://evmrpc.0g.ai)
 *
 * The 0G broker only reads here, so a throwaway wallet with no funds is enough.
 */
import { getChain, isLocalChain, resolveRpcUrl } from '@starter/shared/chains'
import {
  verifyEntry,
  type EntryBundle,
  type VerifyDecision,
  type VerifyStatus,
} from '@starter/shared/verify'
import { createPublicClient, http, type PublicClient } from 'viem'

const entryId = process.argv[2]
if (!entryId || !/^\d+$/.test(entryId)) {
  console.error('Usage: pnpm verify <entryId>')
  process.exit(2)
}
const serverUrl = process.env.SERVER_URL || 'http://localhost:8787'

const res = await fetch(`${serverUrl}/api/entries/${entryId}`)
if (!res.ok) {
  console.error(`Entry ${entryId}: server said ${res.status} ${await res.text()}`)
  process.exit(1)
}
const bundle = (await res.json()) as EntryBundle & { chainId: number }
const chain = getChain(bundle.chainId)
const client = createPublicClient({
  chain,
  transport: http(resolveRpcUrl(chain, process.env.RPC_URL)),
}) as unknown as PublicClient
const rpcChain = await client.getChainId()
if (rpcChain !== bundle.chainId) {
  console.error(`RPC is on chain ${rpcChain}, the server's data is for ${bundle.chainId}`)
  process.exit(1)
}

async function teeVerifier() {
  const { createZGComputeNetworkBroker } = await import('@0gfoundation/0g-compute-ts-sdk')
  const { ethers } = await import('ethers')
  const provider = new ethers.JsonRpcProvider(process.env.ZG_RPC_URL || 'https://evmrpc.0g.ai')
  const broker = await createZGComputeNetworkBroker(
    new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider),
  )
  return async (d: VerifyDecision) =>
    Boolean(d.chatId) && (await broker.inference.processResponse(d.provider, d.chatId!)) === true
}

const report = await verifyEntry(bundle, client, {
  chainId: bundle.chainId,
  ...(isLocalChain(bundle.chainId) ? {} : { verifyTee: await teeVerifier() }),
})

const TAG: Record<VerifyStatus, string> = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP' }
console.log(
  `Entry ${entryId}: will ${bundle.trader.name}'s trade make money? ` +
    `Claimed ${bundle.entry.outcome} on ${chain.name}\n`,
)
for (const s of report.steps) console.log(`${TAG[s.status]}  ${s.label}\n      ${s.detail}`)
console.log(report.ok ? '\nPASS: no check failed' : '\nFAIL: at least one check failed')
process.exit(report.ok ? 0 : 1)
