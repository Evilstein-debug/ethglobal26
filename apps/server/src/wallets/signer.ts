/**
 * The only code path that signs for an agent. Every transaction and typed-data signature goes
 * through the egress allowlist (egress.ts) and the pause switch first; a denial throws
 * EgressDenied with a machine-readable reason. Private keys never leave this module's closure.
 */
import {
  createWalletClient,
  http,
  type Account,
  type Chain,
  type Hash,
  type Hex,
  type TypedDataDefinition,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { checkMessage, checkTx, checkTypedData, type EgressConfig, type TxRequest } from './egress'

export class EgressDenied extends Error {
  constructor(readonly reason: string) {
    super(`agent signer refused: ${reason}`)
    this.name = 'EgressDenied'
  }
}

export type AgentSignerOptions = {
  privateKey: Hex
  chain: Chain
  rpcUrl: string
  egress: EgressConfig
  /** Re-read on every call so a pause takes effect immediately. */
  isPaused: () => Promise<boolean>
  pollingInterval?: number
}

export class AgentSigner {
  readonly address
  readonly #account: Account
  readonly #wallet
  readonly #opts: AgentSignerOptions

  constructor(opts: AgentSignerOptions) {
    this.#opts = opts
    this.#account = privateKeyToAccount(opts.privateKey)
    this.address = this.#account.address
    this.#wallet = createWalletClient({
      account: this.#account,
      chain: opts.chain,
      transport: http(opts.rpcUrl),
      pollingInterval: opts.pollingInterval,
    })
  }

  async #guard(verdict: { ok: boolean; reason?: string }) {
    if (await this.#opts.isPaused()) throw new EgressDenied('paused')
    if (!verdict.ok) throw new EgressDenied(verdict.reason ?? 'denied')
  }

  async sendTransaction(tx: TxRequest): Promise<Hash> {
    await this.#guard(checkTx(this.#opts.egress, tx))
    return this.#wallet.sendTransaction({
      account: this.#account,
      chain: this.#opts.chain,
      to: tx.to,
      data: tx.data,
      value: tx.value,
    })
  }

  /** EIP-191 signature, only for Flash's exact cancel message. */
  async signMessage(message: string): Promise<Hex> {
    await this.#guard(checkMessage(message))
    return this.#account.signMessage!({ message })
  }

  async signTypedData(typed: TypedDataDefinition): Promise<Hex> {
    await this.#guard(checkTypedData(this.#opts.egress, typed as never))
    return this.#account.signTypedData!(typed)
  }
}
