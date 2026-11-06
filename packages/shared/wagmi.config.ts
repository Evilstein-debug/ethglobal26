/**
 * `pnpm codegen` runs this: it rebuilds the Foundry project and writes typed ABIs (`as const`)
 * plus deployed addresses to src/generated.ts. Never edit generated.ts by hand.
 * Docs: https://wagmi.sh/cli/api/plugins/foundry
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { defineConfig } from '@wagmi/cli'
import { foundry } from '@wagmi/cli/plugins'
import { isAddress, type Address } from 'viem'

const CONTRACTS_DIR = '../contracts'
const DEPLOYMENTS_DIR = './deployments'

// Only generate bindings for our own contracts (src/**), not OpenZeppelin or forge-std.
// Forge writes artifacts to out/<File>.sol/<Contract>.json.
function solidityFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return solidityFiles(path)
    return name.endsWith('.sol') ? [relative(dir, path).split('/').pop()!] : []
  })
}

// deployments/<chainId>.json → { ContractName: { [chainId]: address } }
function readDeployments(): Record<string, Record<number, Address>> {
  const result: Record<string, Record<number, Address>> = {}
  for (const file of readdirSync(DEPLOYMENTS_DIR)) {
    if (!file.endsWith('.json')) continue
    const json = JSON.parse(readFileSync(join(DEPLOYMENTS_DIR, file), 'utf8')) as Record<
      string,
      unknown
    >
    const chainId = Number(json.chainId)
    for (const [name, value] of Object.entries(json)) {
      if (typeof value !== 'string' || !isAddress(value)) continue
      ;(result[name] ??= {})[chainId] = value
    }
  }
  return result
}

export default defineConfig({
  out: 'src/generated.ts',
  plugins: [
    foundry({
      project: CONTRACTS_DIR,
      include: solidityFiles(join(CONTRACTS_DIR, 'src')).map((file) => `${file}/**`),
      // `include` already limits output to src/; the plugin's default excludes would also drop
      // any of our files that share a name with forge-std's (e.g. MockERC20.sol).
      exclude: [],
      deployments: readDeployments(),
    }),
  ],
})
