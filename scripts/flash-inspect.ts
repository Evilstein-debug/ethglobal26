/**
 * READ-ONLY Flash check for Base: run once with your integrator key before the first live trade.
 *   pnpm tsx scripts/flash-inspect.ts [funderAddress]
 * Reads FLASH_API_KEY from the environment or apps/server/.env.
 *
 * It only asks for quotes (no signatures, no orders, no funds move) and prints:
 *   - the WETH asset and its price
 *   - for $2 / $5 / $10 buys with an attached ±2% bracket: estimated fees and price impact
 *   - the approval spender(s) and EIP-712 verifyingContract(s) Flash asks the funder to use
 * Paste the addresses into FLASH_APPROVAL_SPENDERS / FLASH_TYPED_DATA_CONTRACTS
 * (apps/server/.env) and record them in VERIFIED.md.
 */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { FlashClient } from '@starter/flash'
import { decodeFunctionData, erc20Abi, isAddress, type Hex } from 'viem'

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' // Base USDC (Circle), see VERIFIED.md
const WETH = '0x4200000000000000000000000000000000000006' // Base WETH9, see VERIFIED.md

const serverEnv = resolve(import.meta.dirname, '../apps/server/.env')
if (!process.env.FLASH_API_KEY && existsSync(serverEnv)) process.loadEnvFile(serverEnv)
const apiKey = process.env.FLASH_API_KEY
if (!apiKey) throw new Error('Set FLASH_API_KEY (environment or apps/server/.env)')
// Any address works for quoting; a fresh one shows the first-trade approvals.
const funder = process.argv[2] ?? '0x000000000000000000000000000000000000dEaD'
if (!isAddress(funder)) throw new Error(`not an address: ${funder}`)

const flash = new FlashClient({ apiKey })
const spenders = new Set<string>()
const domains = new Set<string>()

const [weth] = await flash.search('WETH', 'base', 1)
if (!weth) throw new Error('WETH not found on base')
console.log(`WETH on base: ${weth.address} @ $${weth.price}`)
const price = Number(weth.price)

for (const qty of ['2', '5', '10']) {
  try {
    const q = await flash.quote({
      targetChain: 'base',
      contraChain: 'base',
      targetAsset: WETH,
      contraAsset: USDC,
      side: 'buy',
      qty,
      orderType: 'market',
      funderAddress: funder,
      evmUsePermit2: false,
      forceMinimalAllowance: true,
      attachedBracket: {
        takeProfit: { notionalPrice: (price * 1.02).toFixed(2) },
        stopLoss: { notionalPrice: (price * 0.98).toFixed(2) },
      },
    })
    const fee = Number(q.fees.estimatedFeeNotional)
    const pct = ((fee / Number(qty)) * 100).toFixed(2)
    console.log(
      `\n$${qty} buy: fee ~$${fee.toFixed(4)} (${pct}%), impact ${q.estimatedPriceImpact}`,
    )
    const legs = [
      ['entry', q.evm?.approveTx, q.evm?.orderTypedData],
      ['bracket', q.attachedBracket?.evm?.approveTx, q.attachedBracket?.evm?.orderTypedData],
    ] as const
    for (const [label, tx, typed] of legs) {
      if (tx) {
        const { args } = decodeFunctionData({ abi: erc20Abi, data: tx.data as Hex })
        spenders.add(String(args?.[0]))
        console.log(`  ${label} approve: token ${tx.to} → spender ${String(args?.[0])}`)
      }
      if (typed) {
        const { domain, primaryType } = JSON.parse(typed)
        domains.add(domain.verifyingContract)
        console.log(
          `  ${label} typed data: ${primaryType} @ ${domain.verifyingContract} (chainId ${domain.chainId})`,
        )
      }
    }
  } catch (err) {
    console.log(`\n$${qty} buy: ${err instanceof Error ? err.message : err}`)
  }
}

console.log('\nPaste into apps/server/.env:')
console.log(`FLASH_APPROVAL_SPENDERS=${[...spenders].join(',')}`)
console.log(`FLASH_TYPED_DATA_CONTRACTS=${[...domains].join(',')}`)
