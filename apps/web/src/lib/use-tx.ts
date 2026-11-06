'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { BaseError, ContractFunctionRevertedError, UserRejectedRequestError, type Hash } from 'viem'
import { useConfig } from 'wagmi'
import {
  getAccount,
  simulateContract,
  waitForTransactionReceipt,
  writeContract,
  type SimulateContractParameters,
} from 'wagmi/actions'

export type TxState =
  | { status: 'idle' }
  | { status: 'simulating' | 'signing' }
  | { status: 'pending' | 'confirmed'; hash: Hash }
  | { status: 'failed'; error: string; hash?: Hash }

/** Plain-language reasons for our contracts' custom errors (Arena, TradeLog). */
const REVERT_MESSAGES: Record<string, string> = {
  SameHuman: "You can't predict on your own agent (same human). Use another verified wallet.",
  RoundIsLocked: 'Predictions are closed for this round.',
  AlreadyPredicted: 'You already predicted on this entry.',
  NotRegistered: 'This wallet is not a verified owner or registered agent yet.',
  InvalidProbability: 'The probability must agree with the side (YES ≥ 50%, NO ≤ 50%).',
  EntryNotPending: 'This entry is already resolved.',
  UnknownEntry: 'Unknown entry.',
  NothingToClaim: 'Nothing to claim for this epoch (or already claimed).',
  NotHumanOwner: "Only the verified owner's wallet can claim rewards.",
}

function describeError(error: unknown) {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return 'Rejected in wallet'
    const revert = error.walk((e) => e instanceof ContractFunctionRevertedError)
    const name =
      revert instanceof ContractFunctionRevertedError ? revert.data?.errorName : undefined
    if (name && REVERT_MESSAGES[name]) return REVERT_MESSAGES[name]
    if (name) return `Reverted: ${name}`
    // OpenZeppelin ERC20 custom errors (not in viem's erc20Abi).
    if (error.message.includes('0xe450d38c')) return 'Insufficient token balance in your wallet'
    if (error.message.includes('0xfb8f41b2')) return 'Insufficient token allowance'
    return error.shortMessage
  }
  return error instanceof Error ? error.message : String(error)
}

/**
 * Contract writes done safely: simulate first (shows the revert reason before the wallet
 * prompt), then sign, then wait for the receipt. Refreshes all reads once confirmed.
 */
export function useTx() {
  const config = useConfig()
  const queryClient = useQueryClient()
  const [state, setState] = useState<TxState>({ status: 'idle' })

  async function send(params: SimulateContractParameters) {
    const { address: account } = getAccount(config)
    if (!account) return setState({ status: 'failed', error: 'Connect a wallet first' })
    let hash: Hash | undefined
    try {
      setState({ status: 'simulating' })
      const { request } = await simulateContract(config, { ...params, account })
      setState({ status: 'signing' })
      hash = await writeContract(config, request)
      setState({ status: 'pending', hash })
      const receipt = await waitForTransactionReceipt(config, { hash })
      if (receipt.status !== 'success') throw new Error('Transaction reverted')
      setState({ status: 'confirmed', hash })
      await queryClient.invalidateQueries()
      return receipt
    } catch (error) {
      setState({ status: 'failed', error: describeError(error), hash })
    }
  }

  const busy =
    state.status === 'simulating' || state.status === 'signing' || state.status === 'pending'
  return { state, send, busy }
}
