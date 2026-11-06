/**
 * `pnpm e2e:happy`: the source of truth that the stack works, before touching UI.
 * Grows phase by phase until it runs a full round (CLAUDE.md §8). Today:
 *   anvil → deploy → server up (db, chain) → owner verifies (dev verifier, anvil only) and is
 *   registered in Arena → agent created and registered → funded with MockUSDC + ETH →
 *   trade previews show deny reasons → USDC withdraw through the agent signer → a second wallet
 *   for the same human is rejected → manual bracket trade through the LOCAL Flash stub (commit →
 *   fill → recordExecution onchain) → take-profit fires → position closed → pause blocks the agent.
 *
 * Local anvil only: it never touches a live chain.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import {
  addressOn,
  getChain,
  isLocalChain,
  parseChainId,
  resolveRpcUrl,
} from '@starter/shared/chains'
import { authHeader, authMessage } from '@starter/shared/auth'
import {
  arenaAbi,
  arenaAddress,
  mockUsdcAbi,
  mockUsdcAddress,
  tradeLogAbi,
  tradeLogAddress,
} from '@starter/shared/generated'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseUnits,
  type Address,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { anvilAccount, deployLocal, ensureAnvil, LOCAL_RPC_URL, ROOT, waitFor } from './lib/local'

const chainId = parseChainId(process.env.CHAIN_ID)
const chain = getChain(chainId)
const isLocal = isLocalChain(chainId)
const rpcUrl = resolveRpcUrl(chain, process.env.RPC_URL)
const serverUrl = process.env.SERVER_URL || 'http://localhost:8787'
const pollingInterval = isLocal ? 200 : undefined
const EPOCH_MS = 12_000

const publicClient = createPublicClient({ chain, transport: http(rpcUrl), pollingInterval })
const started: ChildProcess[] = []

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function step(label: string) {
  const start = Date.now()
  console.log(`• ${label}`)
  return (detail = '') => console.log(`  ✓ ${detail ? `${detail} ` : ''}(${Date.now() - start}ms)`)
}

type Health = { chainId: number; db: boolean; humanVerifier: string; flash: string }
async function health(): Promise<Health | undefined> {
  try {
    const res = await fetch(`${serverUrl}/health`)
    return res.ok ? ((await res.json()) as Health) : undefined
  } catch {
    return undefined
  }
}

async function setup() {
  console.log(`e2e:happy on ${chain.name} (${chain.id}) · server ${serverUrl}\n`)
  assert(isLocal, 'Phase 0 e2e runs on local anvil only (CHAIN_ID=31337)')
  {
    let done = step('anvil')
    const anvil = await ensureAnvil()
    if (anvil) started.push(anvil)
    done()

    const address = addressOn(mockUsdcAddress, chainId)
    const code = address && (await publicClient.getCode({ address }))
    if (!code || code === '0x') {
      done = step('deploy (fresh chain)')
      await deployLocal()
      done()
    }

    if (!(await health())) {
      done = step('start server')
      started.push(
        spawn('pnpm', ['--filter', '@starter/server', 'start'], {
          cwd: ROOT,
          env: {
            ...process.env,
            CHAIN_ID: '31337',
            RPC_URL: LOCAL_RPC_URL,
            DATABASE_URL: 'memory://',
            // Rounds are stepped by this script through /api/dev/rounds/tick (local only).
            ROUNDS_ENABLED: 'false',
            ROUND_REGISTRATION_MS: '1000',
            ROUND_PREDICTING_MS: '1000',
            ROUND_TRADING_MS: '1500',
            REWARD_EPOCH_MS: String(EPOCH_MS),
            REWARD_MIN_PREDICTIONS: '1',
          },
          stdio: 'ignore',
        }),
      )
      await waitFor(async () => Boolean(await health()), 'server', 30_000)
      done()
    }
  }
  const status = await health()
  assert(status, `server not reachable at ${serverUrl}`)
  assert(status.chainId === chain.id, `server is on chain ${status.chainId}, expected ${chain.id}`)
  assert(status.db, 'server database is up')
}

/** A fresh owner wallet that signs API auth headers (it never needs funds). */
function owner() {
  const account = privateKeyToAccount(generatePrivateKey())
  return {
    account,
    address: account.address,
    auth: async () => {
      const issuedAt = Date.now()
      const signature = await account.signMessage({
        message: authMessage(account.address, issuedAt),
      })
      return authHeader(account.address, issuedAt, signature)
    },
  }
}

async function api(method: string, path: string, opts: { auth?: string; body?: unknown } = {}) {
  const res = await fetch(`${serverUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(opts.auth ? { authorization: opts.auth } : {}),
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  })
  const body = (await res.json()) as Record<string, unknown>
  return { status: res.status, body }
}

async function run() {
  await setup()
  const usdc = addressOn(mockUsdcAddress, chainId)
  const arena = addressOn(arenaAddress, chainId)
  assert(usdc && arena, `contracts missing on chain ${chainId}; deploy and run pnpm codegen`)
  const status = await health()
  assert(status?.humanVerifier === 'dev', 'local server uses the dev human verifier')

  const tradeLog = addressOn(tradeLogAddress, chainId)
  assert(tradeLog, 'TradeLog deployed')
  const funder = createWalletClient({
    account: anvilAccount(1).account,
    chain,
    transport: http(rpcUrl),
    pollingInterval,
  })
  const humanOf = (a: Address) =>
    publicClient.readContract({ address: arena, abi: arenaAbi, functionName: 'humanOf', args: [a] })
  const usdcOf = (a: Address) =>
    publicClient.readContract({
      address: usdc,
      abi: mockUsdcAbi,
      functionName: 'balanceOf',
      args: [a],
    })
  const humanName = `e2e-${Date.now()}`

  let done = step('owner verifies (dev verifier) and is registered in Arena')
  const bob = owner()
  const verified = await api('POST', '/api/owners/verify', {
    auth: await bob.auth(),
    body: { proof: { devHuman: humanName } },
  })
  assert(verified.status === 201, `verify: ${JSON.stringify(verified.body)}`)
  assert((await humanOf(bob.address)) === verified.body.humanId, 'Arena.humanOf(owner) matches')
  done(String(verified.body.registerTx))

  done = step('create agent; registered onchain under the same human')
  const created = await api('POST', '/api/agents', {
    auth: await bob.auth(),
    body: {
      name: 'Alpha',
      mode: 'both',
      policy: { perTradeCap: '5', roundTradeCap: '10', dailyCap: '20' },
    },
  })
  assert(created.status === 201, `create agent: ${JSON.stringify(created.body)}`)
  const agentId = created.body.id as string
  const agent = created.body.address as Address
  assert((await humanOf(agent)) === verified.body.humanId, 'Arena.humanOf(agent) matches owner')
  done(agent)

  done = step('fund agent: 10 mUSDC + 0.01 ETH for gas')
  for (const hash of [
    await funder.writeContract({
      address: usdc,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [agent, parseUnits('10', 6)],
    }),
    await funder.sendTransaction({ to: agent, value: parseEther('0.01') }),
  ]) {
    assert(
      (await publicClient.waitForTransactionReceipt({ hash })).status === 'success',
      `funding tx ${hash}`,
    )
  }
  const view = await api('GET', `/api/agents/${agentId}`)
  assert(
    (view.body.balances as { usdc: string }).usdc === '10',
    `balance shown: ${JSON.stringify(view.body.balances)}`,
  )
  done()

  done = step('trade previews: allowed, over cap, asset not allowed')
  const auth = await bob.auth()
  const preview = async (amount: string, asset = 'WETH') =>
    JSON.stringify(
      (await api('POST', `/api/agents/${agentId}/trade-preview`, { auth, body: { amount, asset } }))
        .body,
    )
  assert((await preview('2')) === '{"allowed":true}', 'a 2 USDC trade passes')
  assert((await preview('6')) === '{"allowed":false,"reason":"over_trade_cap"}', 'over_trade_cap')
  assert(
    (await preview('1', 'PEPE')) === '{"allowed":false,"reason":"asset_not_allowed"}',
    'asset_not_allowed',
  )
  done()

  done = step('withdraw 1 USDC to the owner through the agent signer')
  const withdrawn = await api('POST', `/api/agents/${agentId}/withdraw`, {
    auth,
    body: { asset: 'USDC', amount: '1' },
  })
  assert(withdrawn.status === 200, `withdraw: ${JSON.stringify(withdrawn.body)}`)
  assert((await usdcOf(bob.address)) === parseUnits('1', 6), 'owner received 1 USDC')
  assert((await usdcOf(agent)) === parseUnits('9', 6), 'agent kept 9 USDC')
  done(String(withdrawn.body.hash))

  done = step('same human, second wallet → rejected')
  const sybil = owner()
  const again = await api('POST', '/api/owners/verify', {
    auth: await sybil.auth(),
    body: { proof: { devHuman: humanName } },
  })
  assert(
    again.status === 409 && again.body.error === 'human_already_registered',
    `sybil: ${JSON.stringify(again.body)}`,
  )
  done()

  done = step('manual bracket trade via the LOCAL Flash stub: commit → fill → recordExecution')
  assert(status?.flash === 'local-stub', 'local server uses the Flash stub')
  await api('POST', '/api/dev/flash-stub/price', { body: { priceUsd: 3000 } })
  const trade = await api('POST', `/api/agents/${agentId}/manual-trade`, {
    auth,
    body: { sizeQuote: '5', entryRefPrice: '3000', stopPrice: '2950', targetPrice: '3060' },
  })
  assert(
    trade.status === 201 && trade.body.status === 'executed',
    `trade: ${JSON.stringify(trade.body)}`,
  )
  const intentHash = trade.body.intentHash as `0x${string}`
  const [, , , onchainStatus] = await publicClient.readContract({
    address: tradeLog,
    abi: tradeLogAbi,
    functionName: 'intents',
    args: [intentHash],
  })
  assert(onchainStatus === 2, `TradeLog status Executed, got ${onchainStatus}`)
  const [commitRcpt, recordRcpt] = await Promise.all([
    publicClient.getTransactionReceipt({ hash: trade.body.commitTx as `0x${string}` }),
    publicClient.getTransactionReceipt({ hash: trade.body.recordTx as `0x${string}` }),
  ])
  assert(
    commitRcpt.blockNumber < recordRcpt.blockNumber,
    'commit mined before the execution record',
  )
  done(intentHash)

  done = step('take-profit fires; position closed with realized profit')
  await api('POST', '/api/dev/flash-stub/price', { body: { priceUsd: 3100 } })
  const closed = await api('POST', `/api/agents/${agentId}/intents/${trade.body.intentId}/close`, {
    auth,
  })
  assert(
    closed.body.status === 'closed' && closed.body.via === 'bracket',
    `close: ${JSON.stringify(closed.body)}`,
  )
  const history = await api('GET', `/api/agents/${agentId}/intents`)
  const row = (
    history.body.intents as { state: string; usdcSpent: number; usdcReceived: number }[]
  )[0]!
  assert(
    row.state === 'CLOSED' && row.usdcReceived > row.usdcSpent,
    `closed in profit: ${JSON.stringify(row)}`,
  )
  done(`pnl +${((row.usdcReceived - row.usdcSpent) / 1e6).toFixed(4)} USDC (stub)`)

  done = step(
    'round: allocation → entry → prediction (other human) → lock → trade → TP → resolve YES',
  )
  const alice = owner()
  await api('POST', '/api/owners/verify', {
    auth: await alice.auth(),
    body: { proof: { devHuman: `${humanName}-alice` } },
  })
  const beta = await api('POST', '/api/agents', {
    auth: await alice.auth(),
    body: {
      name: 'Beta',
      mode: 'predict',
      policy: { perTradeCap: '1', roundTradeCap: '1', dailyCap: '1' },
    },
  })
  assert(beta.status === 201, `create Beta: ${JSON.stringify(beta.body)}`)
  const poolAmount = parseUnits('10', 6)
  for (const hash of [
    await funder.sendTransaction({ to: beta.body.address as Address, value: parseEther('0.01') }),
    await funder.sendTransaction({ to: bob.address, value: parseEther('0.01') }),
    await funder.writeContract({
      address: usdc,
      abi: mockUsdcAbi,
      functionName: 'mint',
      args: [funder.account.address, poolAmount],
    }),
    await funder.writeContract({
      address: usdc,
      abi: mockUsdcAbi,
      functionName: 'approve',
      args: [arena, poolAmount],
    }),
    await funder.writeContract({
      address: arena,
      abi: arenaAbi,
      functionName: 'fund',
      args: [poolAmount],
    }),
  ]) {
    assert(
      (await publicClient.waitForTransactionReceipt({ hash })).status === 'success',
      `setup tx ${hash}`,
    )
  }
  await api('POST', '/api/dev/flash-stub/price', { body: { priceUsd: 3000 } })
  const tickRound = async () => (await api('POST', '/api/dev/rounds/tick')).body.acted
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const first = await api('POST', '/api/dev/rounds/tick')
  assert(first.body.acted === 'started', `round started: ${JSON.stringify(first.body)}`)
  const current = async () =>
    (await api('GET', '/api/rounds/current')).body as {
      id: number
      epochId: number
      phase: string
      entries: {
        id: number
        trader: { id: string }
        outcome: string
        pnlBps: number
        predictions: { yes: number }
      }[]
    }
  let round = await current()
  const entry = round.entries.find((e) => e.trader.id === agentId)
  assert(entry, `Alpha entered round ${round.id}: ${JSON.stringify(round.entries)}`)
  await pause(1100)
  assert((await tickRound()) === 'REGISTRATION', '→ PREDICTING')
  round = await current()
  assert(
    round.entries.find((e) => e.id === entry.id)!.predictions.yes === 1,
    'Beta predicted YES on Alpha',
  )
  await pause(1100)
  assert((await tickRound()) === 'PREDICTING', '→ TRADING')
  await api('POST', '/api/dev/flash-stub/price', { body: { priceUsd: 3100 } })
  await pause(1600)
  assert((await tickRound()) === 'TRADING', '→ RESOLVING → SETTLED')
  round = await current()
  const resolved = round.entries.find((e) => e.id === entry.id)!
  assert(
    round.phase === 'SETTLED' && resolved.outcome === 'YES' && resolved.pnlBps > 0,
    `resolved: ${JSON.stringify(resolved)}`,
  )
  const detail = await api('GET', `/api/entries/${entry.id}`)
  const decisions = detail.body.decisions as { model: string; requestId: string }[]
  assert(
    decisions.length >= 3 && decisions.every((d) => d.model === 'local-stub'),
    'entry detail lists labeled decisions',
  )
  done(`round ${round.id}, entry ${entry.id} YES +${resolved.pnlBps} bps`)

  done = step('epoch ends → awards published → owner claims onchain')
  const epochEnd = (round.epochId + 1) * EPOCH_MS
  await pause(Math.max(0, epochEnd - Date.now()) + 200)
  await tickRound()
  const epochs = (await api('GET', '/api/epochs')).body.epochs as {
    id: number
    status: string
    awards: { ownerWallet: string; amount: number }[]
  }[]
  const epoch = epochs.find((e) => e.id === round.epochId)
  assert(epoch?.status === 'published', `epoch published: ${JSON.stringify(epoch)}`)
  const bobAward = epoch.awards.find((a) => a.ownerWallet === bob.address.toLowerCase())
  assert(bobAward && bobAward.amount > 0, 'Bob earned a trader award')
  const bobWallet = createWalletClient({
    account: bob.account,
    chain,
    transport: http(rpcUrl),
    pollingInterval,
  })
  const before = await usdcOf(bob.address)
  const claimHash = await bobWallet.writeContract({
    address: arena,
    abi: arenaAbi,
    functionName: 'claim',
    args: [BigInt(round.epochId)],
  })
  assert(
    (await publicClient.waitForTransactionReceipt({ hash: claimHash })).status === 'success',
    'claim tx',
  )
  assert((await usdcOf(bob.address)) === before + BigInt(bobAward.amount), 'Bob received his award')
  const board = (await api('GET', '/api/leaderboard')).body as {
    traders: { agentId: string }[]
    predictors: { agentId: string }[]
  }
  assert(board.traders[0]?.agentId === agentId, 'Alpha tops the trader leaderboard')
  assert(
    board.predictors.some((p) => p.agentId === beta.body.id),
    'Beta on the predictor leaderboard',
  )
  done(`${bobAward.amount / 1e6} USDC claimed`)

  done = step('pause blocks the agent')
  await api('POST', `/api/agents/${agentId}/pause`, { auth })
  assert((await preview('1')) === '{"allowed":false,"reason":"paused"}', 'paused preview')
  const blocked = await api('POST', `/api/agents/${agentId}/withdraw`, {
    auth,
    body: { asset: 'USDC', amount: '1' },
  })
  assert(
    blocked.status === 409 && blocked.body.reason === 'paused',
    `paused withdraw refused: ${JSON.stringify(blocked.body)}`,
  )
  done()

  console.log('\n✅ e2e:happy passed')
}

const cleanup = () => started.forEach((child) => child.kill('SIGTERM'))
run()
  .then(() => {
    cleanup()
    process.exit(0)
  })
  .catch((error) => {
    console.error('\n❌ e2e:happy failed:', error instanceof Error ? error.message : error)
    cleanup()
    process.exit(1)
  })
