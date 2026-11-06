'use client'

import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { BaseError, UserRejectedRequestError, type Hash } from 'viem'
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

function describeError(error: unknown) {
  if (error instanceof BaseError) {
    if (error.walk((e) => e instanceof UserRejectedRequestError)) return 'Rejected in wallet'
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
