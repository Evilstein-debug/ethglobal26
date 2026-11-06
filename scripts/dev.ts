/**
 * `pnpm dev`: the app on a local chain with real services: 0G, World ID, Neon, live prices and
 * news from apps/server/.env. Only the chain and Flash fills are local, and both are labeled.
 *   1. start anvil, restoring the saved chain (or reuse one on :8545)
 *   2. on a new chain: deploy contracts + regenerate typed ABIs/addresses, mint mock USDC to the
 *      dev wallets and fill the reward pool
 *   3. run apps/server and apps/web against chain 31337
 * `LOCAL_STUBS=1 pnpm dev` runs with zero external keys, on labeled stubs and a throwaway chain.
 * `pnpm dev:reset` starts the local world over.
 * For Base, use `pnpm dev:mainnet`, which layers apps/server/.env.mainnet over the app env.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import {
  ANVIL_STATE,
  deployLocal,
  ensureAnvil,
  isDeployed,
  localClient,
  LOCAL_REAL_ENV,
  LOCAL_RPC_URL,
  LOCAL_SERVER_ENV,
  ROOT,
  seedLocal,
} from './lib/local'

const stubs = process.env.LOCAL_STUBS === '1'

const children: ChildProcess[] = []

function shutdown(code = 0) {
  for (const child of children) child.kill('SIGTERM')
  process.exit(code)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

function startApp(name: string, filter: string, env: NodeJS.ProcessEnv) {
  const child = spawn('pnpm', ['--filter', filter, 'dev'], {
    cwd: ROOT,
    env: { ...process.env, ...env, FORCE_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const prefix = `[${name}] `
  const pipe = (stream: NodeJS.ReadableStream, out: NodeJS.WriteStream) =>
    stream.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n'))
        if (line.trim()) out.write(prefix + line + '\n')
    })
  pipe(child.stdout!, process.stdout)
  pipe(child.stderr!, process.stderr)
  child.on('exit', (code) => {
    console.error(`${prefix}exited with code ${code}; stopping everything`)
    shutdown(code ?? 1)
  })
  children.push(child)
}

const anvil = await ensureAnvil(stubs ? undefined : ANVIL_STATE)
if (anvil) children.push(anvil)

try {
  if (stubs || !(await isDeployed())) {
    await deployLocal()
    await seedLocal()
  } else {
    console.log('[dev] restored the saved chain and its contracts')
  }
} catch (error) {
  console.error('[dev] deploy failed:', error)
  shutdown(1)
}

if (stubs) {
  // A throwaway chain gets a throwaway database, keyed by its genesis block hash.
  const genesis = await localClient.getBlock({ blockNumber: 0n })
  const databaseUrl = resolve(ROOT, `apps/server/data/local-${genesis.hash.slice(2, 10)}`)
  console.log(`[dev] server database: ${databaseUrl}`)
  startApp('server', '@starter/server', { ...LOCAL_SERVER_ENV, DATABASE_URL: databaseUrl })
} else {
  startApp('server', '@starter/server', LOCAL_REAL_ENV)
}
startApp('web', '@starter/web', {
  NEXT_PUBLIC_CHAIN_ID: '31337',
  NEXT_PUBLIC_RPC_URL: LOCAL_RPC_URL,
})

console.log('\n[dev] web http://localhost:3000 · server http://localhost:8787 · rpc', LOCAL_RPC_URL)
console.log(
  '[dev] to transact, click "Add 1,000 USDC + 20 ETH to my wallet" in the app, or import an anvil dev account.\n',
)
