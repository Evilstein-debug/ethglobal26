/** Helpers for the local anvil chain, shared by the dev and e2e scripts. */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, openSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPublicClient, http, toHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'

export const ROOT = resolve(import.meta.dirname, '../..')
export const LOCAL_RPC_URL = 'http://127.0.0.1:8545'

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

/** Start anvil (logs to .anvil/anvil.log) unless one is already running on 8545. */
export async function ensureAnvil(): Promise<ChildProcess | undefined> {
  if (await isAnvilUp()) {
    console.log('[anvil] reusing the node already running on 8545')
    return
  }
  mkdirSync(resolve(ROOT, '.anvil'), { recursive: true })
  const log = openSync(resolve(ROOT, '.anvil/anvil.log'), 'w')
  const child = spawn('anvil', ['--host', '127.0.0.1', '--port', '8545'], {
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
    { cwd: resolve(ROOT, 'packages/contracts') },
  )
  await run('pnpm', ['codegen'])
}
