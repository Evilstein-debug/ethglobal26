/**
 * Proof-of-human verification behind one interface, so the route never changes:
 * - 'world' (Phase 6): IDKit proof verified with World on the backend.
 * - 'dev':  LOCAL ANVIL ONLY. Accepts `{ devHuman: "<name>" }` and derives a stable fake nullifier,
 *           so the onboarding flow can be exercised without a World app. env.ts refuses it on
 *           any real chain, and the API labels owners created this way.
 */
import { verifyWorldProof, type WorldConfig } from '@starter/world'
import { keccak256, toBytes } from 'viem'
import { z } from 'zod'

export type HumanCheck =
  { ok: true; nullifierHash: string; method: 'world' | 'dev' } | { ok: false; reason: string }

export interface HumanVerifier {
  readonly method: 'world' | 'dev'
  /** `signal` binds the proof to the owner wallet. */
  verify(proof: unknown, signal: string): Promise<HumanCheck>
}

const devProof = z.object({ devHuman: z.string().min(1).max(64) })

export const devHumanVerifier: HumanVerifier = {
  method: 'dev',
  async verify(proof) {
    const parsed = devProof.safeParse(proof)
    if (!parsed.success) return { ok: false, reason: 'invalid_proof' }
    if (parsed.data.devHuman === 'cancel') return { ok: false, reason: 'verification_cancelled' }
    return {
      ok: true,
      method: 'dev',
      nullifierHash: keccak256(toBytes(`dev-human:${parsed.data.devHuman}`)),
    }
  },
}

/** humanId registered in Arena: keccak256 of the nullifier hash string. */
export function humanIdOf(nullifierHash: string) {
  return keccak256(toBytes(nullifierHash.toLowerCase()))
}

/** World ID 4.0 Proof of Human, verified on our backend (packages/world). */
export function worldHumanVerifier(cfg: WorldConfig): HumanVerifier {
  return {
    method: 'world',
    async verify(proof, signal) {
      const res = await verifyWorldProof(cfg, proof, signal)
      return res.ok ? { ok: true, method: 'world', nullifierHash: res.nullifier } : res
    },
  }
}
