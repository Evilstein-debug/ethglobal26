/**
 * `pnpm dev`: the whole local stack with zero external keys.
 *   1. start anvil (or reuse one on :8545)
 *   2. deploy contracts + regenerate typed ABIs/addresses, mint mock USDC to the dev wallets and
 *      fill the reward pool
 *   3. run apps/server and apps/web against chain 31337
 * For a testnet, use `pnpm dev:testnet` with each app's .env pointing at it.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import {
  deployLocal,
  ensureAnvil,
  localClient,
  LOCAL_RPC_URL,
  LOCAL_SERVER_ENV,
  ROOT,
  seedLocal,
} from './lib/local'

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

const anvil = await ensureAnvil()
if (anvil) children.push(anvil)

try {
  await deployLocal()
  await seedLocal()
} catch (error) {
  console.error('[dev] deploy failed:', error)
  shutdown(1)
}

// One local database per chain: keyed by the genesis block hash, which changes every time anvil
// starts fresh, so the server never mixes rounds from an old chain with new contracts.
const genesis = await localClient.getBlock({ blockNumber: 0n })
const databaseUrl = resolve(ROOT, `apps/server/data/local-${genesis.hash.slice(2, 10)}`)
console.log(`[dev] server database: ${databaseUrl}`)

startApp('server', '@starter/server', { ...LOCAL_SERVER_ENV, DATABASE_URL: databaseUrl })
startApp('web', '@starter/web', {
  NEXT_PUBLIC_CHAIN_ID: '31337',
  NEXT_PUBLIC_RPC_URL: LOCAL_RPC_URL,
})

console.log('\n[dev] web http://localhost:3000 · server http://localhost:8787 · rpc', LOCAL_RPC_URL)
console.log(
  '[dev] to transact, click "Get test funds (local only)" in the app, or import an anvil dev account.\n',
)
