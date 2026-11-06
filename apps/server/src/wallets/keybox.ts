/**
 * Encrypts agent private keys at rest with AES-256-GCM under MASTER_KEY (32 bytes, hex).
 * Format: "v1.<iv b64url>.<tag b64url>.<ciphertext b64url>". The agent id is bound as
 * additional authenticated data, so a ciphertext copied onto another agent row fails to decrypt.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Hex } from 'viem'

export class KeyBox {
  readonly #key: Buffer

  constructor(masterKeyHex: string) {
    const hex = masterKeyHex.startsWith('0x') ? masterKeyHex.slice(2) : masterKeyHex
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error('MASTER_KEY must be 32 bytes of hex (openssl rand -hex 32)')
    }
    this.#key = Buffer.from(hex, 'hex')
  }

  seal(privateKey: Hex, agentId: string): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv)
    cipher.setAAD(Buffer.from(agentId, 'utf8'))
    const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return ['v1', iv, tag, ciphertext]
      .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
      .join('.')
  }

  open(sealed: string, agentId: string): Hex {
    const [version, iv, tag, ciphertext] = sealed.split('.')
    if (version !== 'v1' || !iv || !tag || !ciphertext)
      throw new Error('KeyBox: malformed sealed key')
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'))
    decipher.setAAD(Buffer.from(agentId, 'utf8'))
    decipher.setAuthTag(Buffer.from(tag, 'base64url'))
    const plain = Buffer.concat([
      decipher.update(Buffer.from(ciphertext, 'base64url')),
      decipher.final(),
    ])
    return plain.toString('utf8') as Hex
  }
}
