/**
 * Canonical JSON + hashing for anything we commit onchain (trade intents, predictions).
 * Rules: object keys sorted (recursively, by UTF-16 code unit), no whitespace, UTF-8 bytes,
 * keccak256. Arrays keep their order. The backend, scripts/verify.ts and any third party re-derive
 * the same hash from the stored JSON, so this function must stay deterministic and strict:
 * values JSON can't represent unambiguously (undefined, NaN, Infinity, bigint, functions,
 * non-plain objects) throw instead of being silently dropped or coerced.
 */
import { keccak256, toBytes, type Hex } from 'viem'

export type CanonicalValue =
  null | boolean | number | string | CanonicalValue[] | { [key: string]: CanonicalValue }

function encode(value: unknown, path: string): string {
  if (value === null) return 'null'
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false'
    case 'string':
      return JSON.stringify(value)
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`canonicalJson: non-finite number at ${path}`)
      return JSON.stringify(value)
    case 'object': {
      if (Array.isArray(value))
        return `[${value.map((v, i) => encode(v, `${path}[${i}]`)).join(',')}]`
      const proto = Object.getPrototypeOf(value)
      if (proto !== Object.prototype && proto !== null) {
        throw new Error(`canonicalJson: non-plain object at ${path}`)
      }
      const keys = Object.keys(value).sort()
      const body = keys.map((k) => {
        const v = (value as Record<string, unknown>)[k]
        if (v === undefined) throw new Error(`canonicalJson: undefined at ${path}.${k}`)
        return `${JSON.stringify(k)}:${encode(v, `${path}.${k}`)}`
      })
      return `{${body.join(',')}}`
    }
    default:
      throw new Error(`canonicalJson: unsupported ${typeof value} at ${path}`)
  }
}

/** Deterministic JSON string (sorted keys, no whitespace). Throws on unrepresentable values. */
export function canonicalJson(value: unknown): string {
  return encode(value, '$')
}

/** keccak256 of the canonical JSON's UTF-8 bytes. This is the hash committed onchain. */
export function canonicalHash(value: unknown): Hex {
  return keccak256(toBytes(canonicalJson(value)))
}

/** keccak256 of an ID string (e.g. a 0G request ID), for the bytes32 fields in our contracts. */
export function idHash(id: string): Hex {
  if (!id) throw new Error('idHash: empty id')
  return keccak256(toBytes(id))
}
