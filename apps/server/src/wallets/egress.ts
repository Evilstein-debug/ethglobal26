/**
 * Egress allowlist for agent wallets: the only transactions and signatures an agent may produce.
 * Pure functions so every rule is unit-tested; wallets/signer.ts calls them before signing.
 *
 * Transactions (value must be 0 unless it's an ETH withdrawal to the owner):
 *  - TradeLog: commit / recordExecution / recordFailure
 *  - Arena:    predict
 *  - USDC/WETH: approve(spender = Flash settlement) or transfer(to = owner)
 *  - owner:    plain ETH transfer (withdraw), no calldata
 * Typed data (EIP-712): only Flash orders, i.e. domain.verifyingContract is a configured Flash
 * contract on the active chain. Messages (EIP-191): only Flash's exact single-order cancel text.
 * Flash addresses come from a real quote (scripts/flash-inspect.ts) via env, never guessed.
 */
import { decodeFunctionData, erc20Abi, isAddressEqual, type Address, type Hex } from 'viem'
import { isCancelMessage } from '@starter/flash'
import { arenaAbi, tradeLogAbi } from '@starter/shared/generated'

export type EgressConfig = {
  chainId: number
  owner: Address
  tradeLog: Address
  arena: Address
  /** Tokens the agent may approve/transfer (USDC, WETH). */
  tokens: Address[]
  /** Contracts Flash asks us to approve (settlement / FlashAllowance). Empty → approvals refused. */
  flashSpenders: Address[]
  /** EIP-712 verifyingContract(s) of Flash orders. Empty → typed data refused. */
  flashTypedDataContracts: Address[]
}

const isIn = (list: Address[], a: Address) => list.some((x) => isAddressEqual(x, a))

export type TxRequest = { to: Address; data?: Hex; value?: bigint }
export type Verdict = { ok: true; kind: string } | { ok: false; reason: string }

const deny = (reason: string): Verdict => ({ ok: false, reason })

const TRADELOG_FNS = new Set(['commit', 'recordExecution', 'recordFailure'])
const ARENA_FNS = new Set(['predict'])

function decode<T extends readonly unknown[]>(abi: T, data: Hex | undefined) {
  if (!data || data === '0x') return undefined
  try {
    return decodeFunctionData({ abi: abi as never, data }) as {
      functionName: string
      args: readonly unknown[]
    }
  } catch {
    return undefined
  }
}

export function checkTx(cfg: EgressConfig, tx: TxRequest): Verdict {
  const value = tx.value ?? 0n
  if (value < 0n) return deny('negative_value')

  if (isAddressEqual(tx.to, cfg.owner)) {
    if (tx.data && tx.data !== '0x') return deny('owner_calldata_not_allowed')
    if (value === 0n) return deny('zero_value_transfer')
    return { ok: true, kind: 'withdraw_eth' }
  }
  if (value !== 0n) return deny('value_not_allowed')

  if (isAddressEqual(tx.to, cfg.tradeLog)) {
    const call = decode(tradeLogAbi, tx.data)
    return call && TRADELOG_FNS.has(call.functionName)
      ? { ok: true, kind: `tradelog_${call.functionName}` }
      : deny('tradelog_function_not_allowed')
  }
  if (isAddressEqual(tx.to, cfg.arena)) {
    const call = decode(arenaAbi, tx.data)
    return call && ARENA_FNS.has(call.functionName)
      ? { ok: true, kind: `arena_${call.functionName}` }
      : deny('arena_function_not_allowed')
  }
  if (cfg.tokens.some((t) => isAddressEqual(t, tx.to))) {
    const call = decode(erc20Abi, tx.data)
    if (!call) return deny('token_calldata_invalid')
    if (call.functionName === 'approve') {
      const [spender] = call.args as [Address, bigint]
      if (cfg.flashSpenders.length === 0) return deny('flash_not_configured')
      return isIn(cfg.flashSpenders, spender)
        ? { ok: true, kind: 'token_approve_flash' }
        : deny('approve_spender_not_allowed')
    }
    if (call.functionName === 'transfer') {
      const [to] = call.args as [Address, bigint]
      return isAddressEqual(to, cfg.owner)
        ? { ok: true, kind: 'token_withdraw' }
        : deny('transfer_recipient_not_allowed')
    }
    return deny('token_function_not_allowed')
  }
  return deny('destination_not_allowed')
}

export type TypedDataRequest = {
  domain?: { chainId?: number | bigint | string; verifyingContract?: Address }
  primaryType: string
}

export function checkTypedData(cfg: EgressConfig, typed: TypedDataRequest): Verdict {
  if (cfg.flashTypedDataContracts.length === 0) return deny('flash_not_configured')
  const domain = typed.domain
  if (!domain?.verifyingContract) return deny('typed_data_no_verifying_contract')
  if (!isIn(cfg.flashTypedDataContracts, domain.verifyingContract)) {
    return deny('typed_data_domain_not_allowed')
  }
  if (domain.chainId === undefined || Number(domain.chainId) !== cfg.chainId) {
    return deny('typed_data_wrong_chain')
  }
  return { ok: true, kind: 'flash_order' }
}

/** Agents sign exactly one kind of plain message: Flash's single-order cancel. */
export function checkMessage(message: string): Verdict {
  return isCancelMessage(message) ? { ok: true, kind: 'flash_cancel' } : deny('message_not_allowed')
}
