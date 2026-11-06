/**
 * `pnpm e2e:happy`: the source of truth that the stack works, before touching UI.
 * Runs the path the web app runs (simulate → send → wait for receipt):
 *   deploy → escrow.create → server feed sees it → verify state → escrow.release → verify payout
 *
 * Local (default): starts anvil, deploys and starts the server if they are not already running.
 * Testnet: set CHAIN_ID, RPC_URL, SERVER_URL and E2E_PRIVATE_KEY in the root .env, deploy first,
 * and run the server against the same chain.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import {
  addressOn,
  getChain,
  isLocalChain,
  parseChainId,
  resolveRpcUrl,
} from '@starter/shared/chains'
import { simpleEscrowAbi, simpleEscrowAddress } from '@starter/shared/generated'
import {
  createPublicClient,
  createWalletClient,
  http,
  isHex,
  parseEther,
  parseEventLogs,
  type Hex,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { anvilAccount, deployLocal, ensureAnvil, LOCAL_RPC_URL, ROOT, waitFor } from './lib/local'

const chainId = parseChainId(process.env.CHAIN_ID)
const chain = getChain(chainId)
const isLocal = isLocalChain(chainId)
const rpcUrl = resolveRpcUrl(chain, process.env.RPC_URL)
const serverUrl = process.env.SERVER_URL || 'http://localhost:8787'
const pollingInterval = isLocal ? 200 : undefined
const AMOUNT = parseEther(process.env.E2E_AMOUNT || (isLocal ? '1' : '0.0001'))

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

async function health(): Promise<{ chainId: number } | undefined> {
  try {
    const res = await fetch(`${serverUrl}/health`)
    return res.ok ? ((await res.json()) as { chainId: number }) : undefined
  } catch {
    return undefined
  }
}

/** Payer signs; on anvil it is dev account #1, elsewhere E2E_PRIVATE_KEY (a throwaway key). */
function payerAccount() {
  const key = process.env.E2E_PRIVATE_KEY
  if (key) {
    assert(isHex(key) && key.length === 66, 'E2E_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key')
    return privateKeyToAccount(key as Hex)
  }
  assert(isLocal, `set E2E_PRIVATE_KEY (a funded throwaway ${chain.name} key) in the root .env`)
  return anvilAccount(1).account
}

async function setup() {
  console.log(`e2e:happy on ${chain.name} (${chain.id}) · server ${serverUrl}\n`)
  if (isLocal) {
    let done = step('anvil')
    const anvil = await ensureAnvil()
    if (anvil) started.push(anvil)
    done()

    const address = addressOn(simpleEscrowAddress, chainId)
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
          env: { ...process.env, CHAIN_ID: '31337', RPC_URL: LOCAL_RPC_URL },
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
}

async function run() {
  await setup()
  const escrow = addressOn(simpleEscrowAddress, chainId)
  assert(escrow, `SimpleEscrow has no address for chain ${chainId}; deploy and run pnpm codegen`)

  const payer = createWalletClient({
    account: payerAccount(),
    chain,
    transport: http(rpcUrl),
    pollingInterval,
  })
  const payee = isLocal
    ? anvilAccount(2).account.address
    : privateKeyToAccount(generatePrivateKey()).address

  let done = step(`escrow.create: ${AMOUNT} wei from ${payer.account.address} to ${payee}`)
  const deadline = (await publicClient.getBlock()).timestamp + 3600n
  const { request } = await publicClient.simulateContract({
    account: payer.account,
    address: escrow,
    abi: simpleEscrowAbi,
    functionName: 'create',
    args: [payee, deadline],
    value: AMOUNT,
  })
  const createHash = await payer.writeContract(request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash: createHash })
  assert(receipt.status === 'success', `create reverted (${createHash})`)
  const [created] = parseEventLogs({
    abi: simpleEscrowAbi,
    eventName: 'DealCreated',
    logs: receipt.logs,
  })
  assert(created, 'DealCreated emitted')
  const dealId = created.args.id
  done(`deal #${dealId} ${createHash}`)

  done = step('server feed saw DealCreated')
  await waitFor(
    async () => {
      const res = await fetch(`${serverUrl}/api/feed?limit=100`)
      const { entries } = (await res.json()) as { entries: { txHash: string }[] }
      return entries.some((e) => e.txHash === createHash)
    },
    'DealCreated in the server feed',
    20_000,
  )
  done()

  done = step('verify onchain state')
  const [dealPayer, dealPayee, amount, , status] = await publicClient.readContract({
    address: escrow,
    abi: simpleEscrowAbi,
    functionName: 'deals',
    args: [dealId],
  })
  assert(dealPayer === payer.account.address && dealPayee === payee, 'deal parties')
  assert(amount === AMOUNT && status === 1, 'deal amount and Open status')
  done()

  done = step('escrow.release → payee')
  const before = await publicClient.getBalance({ address: payee })
  const release = await publicClient.simulateContract({
    account: payer.account,
    address: escrow,
    abi: simpleEscrowAbi,
    functionName: 'release',
    args: [dealId],
  })
  const releaseHash = await payer.writeContract(release.request)
  assert(
    (await publicClient.waitForTransactionReceipt({ hash: releaseHash })).status === 'success',
    `release reverted (${releaseHash})`,
  )
  assert((await publicClient.getBalance({ address: payee })) === before + AMOUNT, 'payee was paid')
  done(releaseHash)

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
