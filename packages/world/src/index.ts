/**
 * World ID 4.0 (IDKit) on the backend. Sources (read 2026-11-06):
 *   https://docs.world.org/world-id/idkit/integrate.md, .../idkit/javascript.md
 *
 * 1. rpSignature(): the backend signs each proof request with the RP signing key
 *    (`@worldcoin/idkit-core/signing`). The key never reaches the browser.
 * 2. verify(): never trust the client. We check the action, environment, credential and that the
 *    proof's signal_hash equals hashSignal(owner wallet), so a proof can't be replayed for another
 *    wallet; then forward the IDKit result as-is to POST
 *    https://developer.world.org/api/v4/verify/{rp_id} and require success + matching environment.
 * 3. The nullifier (same person + same app + same action → same value) is normalized to a
 *    decimal integer string, avoiding hex casing/padding ambiguities (docs, Step 6).
 *
 * Credential: Proof of Human, the minimum sufficient assurance for "one human, one account".
 */
import { hashSignal } from '@worldcoin/idkit-core/hashing'
import { signRequest } from '@worldcoin/idkit-core/signing'

export type WorldConfig = {
  appId: string
  rpId: string
  /** Secret: RP signing key from the Developer Portal. */
  signingKeyHex: string
  action: string
  environment: 'production' | 'staging'
  verifyBaseUrl?: string
  fetch?: typeof fetch
}

export type WorldCheck = { ok: true; nullifier: string } | { ok: false; reason: string }

/** Credential identifiers accepted for "unique human" (4.0 and legacy 3.0 orb proofs). */
export const HUMAN_IDENTIFIERS = new Set(['proof_of_human', 'orb'])

type IDKitResponseItem = { identifier?: string; signal_hash?: string; nullifier?: string }
type IDKitResult = {
  protocol_version?: string
  action?: string
  environment?: string
  responses?: IDKitResponseItem[]
}

export function rpSignature(cfg: Pick<WorldConfig, 'signingKeyHex' | 'action'>, ttlSeconds = 300) {
  const { sig, nonce, createdAt, expiresAt } = signRequest({
    signingKeyHex: cfg.signingKeyHex,
    action: cfg.action,
    ttl: ttlSeconds,
  })
  return { sig, nonce, created_at: createdAt, expires_at: expiresAt }
}

/** The signal we bind proofs to: the owner's wallet, lowercased. */
export const walletSignal = (wallet: string) => wallet.toLowerCase()

export function normalizeNullifier(nullifier: string): string {
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(nullifier))
    throw new Error('nullifier is not a 256-bit hex value')
  return BigInt(nullifier).toString(10)
}

const sameHex = (a: string, b: string) => {
  try {
    return BigInt(a) === BigInt(b)
  } catch {
    return false
  }
}

export async function verifyWorldProof(
  cfg: WorldConfig,
  proof: unknown,
  wallet: string,
): Promise<WorldCheck> {
  const p = proof as IDKitResult | undefined
  if (!p || typeof p !== 'object' || !Array.isArray(p.responses) || p.responses.length === 0) {
    return { ok: false, reason: 'invalid_proof' }
  }
  if (p.environment !== cfg.environment) return { ok: false, reason: 'wrong_environment' }
  if (p.action !== cfg.action) return { ok: false, reason: 'wrong_action' }
  const item = p.responses.find((r) => r.identifier && HUMAN_IDENTIFIERS.has(r.identifier))
  if (!item) return { ok: false, reason: 'credential_not_accepted' }
  if (!item.nullifier) return { ok: false, reason: 'invalid_proof' }
  if (!item.signal_hash || !sameHex(item.signal_hash, hashSignal(walletSignal(wallet)))) {
    return { ok: false, reason: 'signal_mismatch' }
  }

  const base = cfg.verifyBaseUrl ?? 'https://developer.world.org/api/v4/verify'
  let res: Response
  try {
    res = await (cfg.fetch ?? fetch)(`${base}/${encodeURIComponent(cfg.rpId)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...p, environment: cfg.environment }),
      signal: AbortSignal.timeout(20_000),
    })
  } catch {
    return { ok: false, reason: 'world_unreachable' }
  }
  if (!res.ok) return { ok: false, reason: 'proof_rejected' }
  const verification = (await res.json().catch(() => undefined)) as
    { success?: boolean; environment?: string } | undefined
  if (verification?.success !== true || verification.environment !== cfg.environment) {
    return { ok: false, reason: 'proof_rejected' }
  }
  try {
    return { ok: true, nullifier: normalizeNullifier(item.nullifier) }
  } catch {
    return { ok: false, reason: 'invalid_proof' }
  }
}

export { hashSignal }
