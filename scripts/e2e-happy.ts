/**
 * `pnpm e2e:happy`: the source of truth that the stack works, before touching UI.
 * Grows phase by phase until it runs a full round (CLAUDE.md §8). Phase 0 checks the plumbing:
 *   anvil → deploy → server up on the right chain with its database → MockUSDC mint → balance
 *
 * Local only for now (MockUSDC exists only on anvil). Live Base checks arrive with Phase 3.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import {
  addressOn,
  getChain,
  isLocalChain,
  parseChainId,
  resolveRpcUrl,
} from '@starter/shared/chains'
import { mockUsdcAbi, mockUsdcAddress } from '@starter/shared/generated'
import { createPublicClient, createWalletClient, http, parseUnits } from 'viem'
import { anvilAccount, deployLocal, ensureAnvil, LOCAL_RPC_URL, ROOT, waitFor } from './lib/local'

const chainId = parseChainId(process.env.CHAIN_ID)
const chain = getChain(chainId)
const isLocal = isLocalChain(chainId)
const rpcUrl = resolveRpcUrl(chain, process.env.RPC_URL)
const serverUrl = process.env.SERVER_URL || 'http://localhost:8787'
const pollingInterval = isLocal ? 200 : undefined
const AMOUNT = parseUnits('25', 6) // 25 mUSDC

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

async function health(): Promise<{ chainId: number; db: boolean } | undefined> {
  try {
    const res = await fetch(`${serverUrl}/health`)
    return res.ok ? ((await res.json()) as { chainId: number; db: boolean }) : undefined
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
  assert(status.db, 'server database is up')
}

async function run() {
  await setup()
  const usdc = addressOn(mockUsdcAddress, chainId)
  assert(usdc, `MockUSDC has no address for chain ${chainId}; deploy and run pnpm codegen`)

  const wallet = createWalletClient({
    account: anvilAccount(1).account,
    chain,
    transport: http(rpcUrl),
    pollingInterval,
  })
  const holder = anvilAccount(2).account.address

  let done = step(`MockUSDC.mint ${AMOUNT} → ${holder}`)
  const before = await publicClient.readContract({
    address: usdc,
    abi: mockUsdcAbi,
    functionName: 'balanceOf',
    args: [holder],
  })
  const { request } = await publicClient.simulateContract({
    account: wallet.account,
    address: usdc,
    abi: mockUsdcAbi,
    functionName: 'mint',
    args: [holder, AMOUNT],
  })
  const hash = await wallet.writeContract(request)
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  assert(receipt.status === 'success', `mint reverted (${hash})`)
  done(hash)

  done = step('verify balance')
  const after = await publicClient.readContract({
    address: usdc,
    abi: mockUsdcAbi,
    functionName: 'balanceOf',
    args: [holder],
  })
  assert(after === before + AMOUNT, `balance ${after}, expected ${before + AMOUNT}`)
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
