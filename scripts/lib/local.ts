/** Helpers for the local anvil chain, shared by the dev and e2e scripts. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { arenaAbi, mockUsdcAbi } from '@starter/shared/generated'
import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  toHex,
  type Address,
  type Hash,
} from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'

export const ROOT = resolve(import.meta.dirname, '../..')
const ANVIL_PORT = process.env.LOCAL_ANVIL_PORT || '8545'
export const LOCAL_RPC_URL = `http://127.0.0.1:${ANVIL_PORT}`
/** `pnpm dev` keeps its chain here, so it lives as long as the server database does. */
export const ANVIL_STATE = resolve(ROOT, '.anvil/state.json')

/** Short so a local run shows a whole trade quickly. Set any of these yourself to override. */
const LOCAL_TIMINGS: NodeJS.ProcessEnv = {
  PREDICTION_WINDOW_MS: process.env.PREDICTION_WINDOW_MS ?? '180000',
  TRADE_MAX_HOLD_MS: process.env.TRADE_MAX_HOLD_MS ?? '420000',
  TRADE_COOLDOWN_MS: process.env.TRADE_COOLDOWN_MS ?? '120000',
  AGENT_THINK_MS: process.env.AGENT_THINK_MS ?? '30000',
  REWARD_EPOCH_MS: process.env.REWARD_EPOCH_MS ?? '600000',
  REWARD_MIN_PREDICTIONS: process.env.REWARD_MIN_PREDICTIONS ?? '1',
}

/**
 * `pnpm dev`: everything real except the chain and Flash fills, which only exist on mainnet.
 * apps/server/.env supplies 0G, World, Neon and the master key. The chain stays local, so the
 * operator stays the anvil account and Flash stays the labeled stub, at live prices.
 */
export const LOCAL_REAL_ENV: NodeJS.ProcessEnv = {
  CHAIN_ID: '31337',
  RPC_URL: LOCAL_RPC_URL,
  OPERATOR_PRIVATE_KEY: '',
  FLASH_API_KEY: '',
  FLASH_APPROVAL_SPENDERS: '',
  FLASH_TYPED_DATA_CONTRACTS: '',
  LOCAL_PRICE_FEED_URL:
    process.env.LOCAL_PRICE_FEED_URL ?? 'https://api.coinbase.com/v2/prices/ETH-USD/spot',
  NEWS_RSS_URLS:
    process.env.NEWS_RSS_URLS ??
    'https://www.coindesk.com/arc/outboundfeeds/rss/,https://cointelegraph.com/rss,https://decrypt.co/feed',
  ...LOCAL_TIMINGS,
}

/**
 * Env for a run with no external services at all (e2e, `LOCAL_STUBS=1 pnpm dev`). Node gives
 * existing env vars precedence over --env-file, so blanking keys here keeps it on labeled stubs.
 */
export const LOCAL_SERVER_ENV: NodeJS.ProcessEnv = {
  CHAIN_ID: '31337',
  RPC_URL: LOCAL_RPC_URL,
  DATABASE_URL: '',
  MASTER_KEY: '',
  OPERATOR_PRIVATE_KEY: '',
  HUMAN_VERIFIER: 'dev',
  FLASH_API_KEY: '',
  FLASH_APPROVAL_SPENDERS: '',
  FLASH_TYPED_DATA_CONTRACTS: '',
  ZEROG_API_KEY: '',
  WORLD_APP_ID: '',
  WORLD_RP_ID: '',
  WORLD_RP_SIGNING_KEY: '',
  LOCAL_PRICE_FEED_URL: '',
  NEWS_RSS_URLS: '',
  ...LOCAL_TIMINGS,
}

// Anvil's documented default mnemonic (https://getfoundry.sh/anvil/overview). Its keys are
// public: local use only. We derive keys from it rather than hard-coding them.
export const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk'

export function anvilAccount(index: number) {
  const account = mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index })
  return { account, privateKey: toHex(account.getHdKey().privateKey!) }
}

export const localClient = createPublicClient({ chain: anvil, transport: http(LOCAL_RPC_URL) })

export async function isAnvilUp(): Promise<boolean> {
  try {
    return (await localClient.getChainId()) === anvil.id
  } catch {
    return false
  }
}

export async function waitFor(check: () => Promise<boolean>, label: string, timeoutMs = 30_000) {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((r) => setTimeout(r, 250))
  }
}

/**
 * Start anvil (logs to .anvil/anvil.log) unless one is already running. With `stateFile` the chain
 * is restored from it and saved back every few seconds and on exit.
 */
export async function ensureAnvil(stateFile?: string): Promise<ChildProcess | undefined> {
  if (await isAnvilUp()) {
    console.log('[anvil] reusing the node already running on', LOCAL_RPC_URL)
    return
  }
  mkdirSync(resolve(ROOT, '.anvil'), { recursive: true })
  const log = openSync(resolve(ROOT, '.anvil/anvil.log'), 'w')
  const persist = stateFile ? ['--state', stateFile, '--state-interval', '5'] : []
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', ANVIL_PORT, ...persist], {
    stdio: ['ignore', log, log],
  })
  child.on('error', (err) => {
    console.error('[anvil] failed to start. Is Foundry installed? See README "Prerequisites".', err)
    process.exit(1)
  })
  await waitFor(isAnvilUp, 'anvil')
  console.log('[anvil] started on', LOCAL_RPC_URL, '(log: .anvil/anvil.log)')
  return child
}

/** Run a command to completion, streaming output; rejects on non-zero exit. */
export function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  return new Promise<void>((resolvePromise, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, ...opts.env },
      stdio: 'inherit',
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`${cmd} ${args.join(' ')} exited with ${code}`)),
    )
  })
}

/** True when a restored chain already holds our contracts, so they keep their addresses. */
export async function isDeployed() {
  try {
    const { Arena } = JSON.parse(
      readFileSync(resolve(ROOT, 'packages/shared/deployments/31337.json'), 'utf8'),
    ) as { Arena: Address }
    return Boolean(await localClient.getCode({ address: Arena }))
  } catch {
    return false
  }
}

/** Deploy all contracts to local anvil with account #0, then regenerate typed bindings. */
export async function deployLocal() {
  await run(
    'forge',
    [
      'script',
      'script/Deploy.s.sol',
      '--rpc-url',
      LOCAL_RPC_URL,
      '--broadcast',
      '--private-key',
      anvilAccount(0).privateKey,
    ],
    {
      cwd: resolve(ROOT, 'packages/contracts'),
      // Forge also loads packages/contracts/.env, which may hold Base settings. Existing env vars
      // win over it, so a local deploy always makes the anvil dev account the operator.
      env: {
        OPERATOR_ADDRESS: anvilAccount(0).account.address,
        ARENA_OWNER: anvilAccount(0).account.address,
        EPOCH_CAP: '5000000',
      },
    },
  )
  await run('pnpm', ['codegen'])
}

/**
 * LOCAL ONLY: give the anvil dev wallets mock USDC to fund agents with, and fill the reward pool.
 * Run after `deployLocal`; addresses are read from the deployments file it just wrote.
 */
export async function seedLocal() {
  const { MockUSDC: usdc, Arena: arena } = JSON.parse(
    readFileSync(resolve(ROOT, 'packages/shared/deployments/31337.json'), 'utf8'),
  ) as { MockUSDC: Address; Arena: Address }
  const operator = createWalletClient({
    account: anvilAccount(0).account,
    chain: anvil,
    transport: http(LOCAL_RPC_URL),
  })
  const send = async (hash: Promise<Hash>) =>
    localClient.waitForTransactionReceipt({ hash: await hash })
  const mint = (to: Address, amount: bigint) =>
    send(
      operator.writeContract({
        address: usdc,
        abi: mockUsdcAbi,
        functionName: 'mint',
        args: [to, amount],
      }),
    )
  for (const i of [1, 2, 3, 4]) await mint(anvilAccount(i).account.address, parseUnits('1000', 6))
  const pool = parseUnits('100', 6)
  await mint(operator.account.address, pool)
  await send(
    operator.writeContract({
      address: usdc,
      abi: mockUsdcAbi,
      functionName: 'approve',
      args: [arena, pool],
    }),
  )
  await send(
    operator.writeContract({ address: arena, abi: arenaAbi, functionName: 'fund', args: [pool] }),
  )
}
