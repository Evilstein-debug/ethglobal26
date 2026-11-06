/**
 * Integration harness: a private anvil per test file, our real contracts deployed from forge's
 * build output (packages/contracts/out), and a full AppContext wired to the LOCAL TEST ONLY
 * Flash stub. Requires Foundry (anvil + `forge build`); without it, callers skip.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { after } from 'node:test'
import { LocalFlashStub } from '@starter/flash'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  parseUnits,
  type Abi,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'
import { arenaAbi, mockUsdcAbi } from '@starter/shared/generated'
import { devHumanVerifier, humanIdOf } from '../auth/human'
import { newsReader } from '../brain/news'
import { createArenaOps } from '../chain/operator'
import { DEFAULT_BRAIN, type AppContext, type FlashSetup } from '../context'
import { freshDb, schema } from '../db/testing'
import { KeyBox } from '../wallets/keybox'

const OUT = resolve(import.meta.dirname, '../../../../packages/contracts/out')
/** LOCAL ONLY: public anvil dev keys #0 (deployer/operator) and #1 (funder). */
const DEPLOYER = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80' as Hex
const FUNDER = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as Hex

export const anvilAvailable =
  spawnSync('anvil', ['--version']).status === 0 && existsSync(resolve(OUT, 'Arena.sol/Arena.json'))
export const skipReason = anvilAvailable ? false : 'needs Foundry (anvil) and `forge build` output'

function artifact(name: string, file = name) {
  const json = JSON.parse(readFileSync(resolve(OUT, `${file}.sol/${name}.json`), 'utf8'))
  return { abi: json.abi as Abi, bytecode: json.bytecode.object as Hex }
}

export async function startAnvilWorld() {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const rpcUrl = `http://127.0.0.1:${port}`
  const proc: ChildProcess = spawn('anvil', ['--port', String(port), '--silent'], {
    stdio: 'ignore',
  })
  after(() => proc.kill('SIGTERM'))
  const publicClient = createPublicClient({
    chain: anvil,
    transport: http(rpcUrl),
    pollingInterval: 50,
  }) as unknown as PublicClient
  for (let i = 0; ; i++) {
    try {
      await publicClient.getChainId()
      break
    } catch {
      if (i > 100) throw new Error('anvil did not start')
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  const deployer = createWalletClient({
    account: privateKeyToAccount(DEPLOYER),
    chain: anvil,
    transport: http(rpcUrl),
    pollingInterval: 50,
  })
  const funder = createWalletClient({
    account: privateKeyToAccount(FUNDER),
    chain: anvil,
    transport: http(rpcUrl),
    pollingInterval: 50,
  })
  async function deploy(name: string, args: unknown[] = [], file?: string) {
    const { abi, bytecode } = artifact(name, file)
    const hash = await deployer.deployContract({ abi, bytecode, args })
    const receipt = await publicClient.waitForTransactionReceipt({ hash })
    return receipt.contractAddress!
  }
  const usdc = await deploy('MockUSDC')
  const weth = await deploy('MockWETH')
  const tradeLog = await deploy('TradeLog')
  const arenaAddress = await deploy('Arena', [
    usdc,
    deployer.account.address,
    deployer.account.address,
    5_000_000n,
  ])

  const db = await freshDb()
  /** A test can move time forward (TWAP tranches, check intervals) without sleeping. */
  const clock = { offset: 0 }
  const now = () => Date.now() + clock.offset
  const stubSettlement = '0x000000000000000000000000000000000000F1a5' as Address
  const stub = new LocalFlashStub({
    chainId: anvil.id,
    verifyingContract: stubSettlement,
    spender: stubSettlement,
    usdc,
    weth,
    priceUsd: 3000,
    now,
  })
  const flash: FlashSetup = {
    api: stub,
    stub,
    chain: 'base',
    integratorFeeBps: '0',
    approvalSpenders: [stubSettlement],
    typedDataContracts: [stubSettlement],
    pollMs: 20,
    fillTimeoutMs: 3000,
  }
  const arena = createArenaOps({
    arena: arenaAddress,
    operatorKey: DEPLOYER,
    chain: anvil,
    rpcUrl,
    publicClient,
    pollingInterval: 50,
  })
  const ctx: AppContext = {
    db,
    chain: anvil,
    rpcUrl,
    pollingInterval: 50,
    publicClient,
    contracts: { tradeLog, arena: arenaAddress, usdc, weth },
    arena,
    keyBox: new KeyBox('ab'.repeat(32)),
    humanVerifier: devHumanVerifier,
    flash,
    allowManualTrades: true,
    brain: DEFAULT_BRAIN,
    readNews: newsReader([]),
    now,
  }

  /** Verified owner (registered onchain) — what POST /api/owners/verify does. */
  async function owner(name: string) {
    const account = privateKeyToAccount(
      `0x${Buffer.from(name.padEnd(32, '_')).toString('hex')}` as Hex,
    )
    const nullifier = `dev-nullifier-${name}`
    const humanId = humanIdOf(nullifier)
    await db.insert(schema.owners).values({
      wallet: account.address.toLowerCase(),
      worldNullifierHash: nullifier,
      humanId,
      verifiedAt: Date.now(),
      verifyMethod: 'dev',
    })
    await arena.registerOwner(account.address, humanId)
    return { wallet: account.address, humanId, account }
  }

  /** Fund an address with mUSDC and ETH for gas. */
  async function fund(to: Address, usdcAmount: string, eth = '0.05') {
    const hashes = [
      await funder.writeContract({
        address: usdc,
        abi: mockUsdcAbi,
        functionName: 'mint',
        args: [to, parseUnits(usdcAmount, 6)],
      }),
      ...(eth !== '0' ? [await funder.sendTransaction({ to, value: parseEther(eth) })] : []),
    ]
    for (const hash of hashes) await publicClient.waitForTransactionReceipt({ hash })
  }

  /** The operator funds the reward pool with freshly minted mUSDC. */
  async function fundPool(usdcAmount: string) {
    const amount = parseUnits(usdcAmount, 6)
    for (const hash of [
      await deployer.writeContract({
        address: usdc,
        abi: mockUsdcAbi,
        functionName: 'mint',
        args: [deployer.account.address, amount],
      }),
      await deployer.writeContract({
        address: usdc,
        abi: mockUsdcAbi,
        functionName: 'approve',
        args: [arenaAddress, amount],
      }),
      await deployer.writeContract({
        address: arenaAddress,
        abi: arenaAbi,
        functionName: 'fund',
        args: [amount],
      }),
    ]) {
      await publicClient.waitForTransactionReceipt({ hash })
    }
  }

  /** The local stub moves no tokens, so a test that needs bought WETH in a wallet mints it. */
  async function mintWeth(to: Address, amount: string) {
    const hash = await funder.writeContract({
      address: weth,
      abi: mockUsdcAbi, // same mint(address,uint256)
      functionName: 'mint',
      args: [to, parseEther(amount)],
    })
    await publicClient.waitForTransactionReceipt({ hash })
  }

  /** A wallet client for an owner account (e.g. to claim rewards). */
  const walletFor = (account: ReturnType<typeof privateKeyToAccount>) =>
    createWalletClient({ account, chain: anvil, transport: http(rpcUrl), pollingInterval: 50 })

  return {
    ctx,
    db,
    stub,
    rpcUrl,
    publicClient,
    owner,
    fund,
    fundPool,
    walletFor,
    mintWeth,
    advance: (ms: number) => void (clock.offset += ms),
    contracts: ctx.contracts,
  }
}
