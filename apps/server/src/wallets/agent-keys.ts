import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import type { KeyBox } from './keybox'

/** New agent wallet: returns its address and the sealed key to store. The raw key is dropped. */
export function createAgentKey(keyBox: KeyBox, agentId: string) {
  const privateKey = generatePrivateKey()
  const { address } = privateKeyToAccount(privateKey)
  return { address, encKey: keyBox.seal(privateKey, agentId) }
}
