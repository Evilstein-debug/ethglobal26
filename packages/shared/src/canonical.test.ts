import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keccak256, toBytes } from 'viem'
import { canonicalHash, canonicalJson, idHash } from './canonical'

test('sorts keys recursively and drops whitespace', () => {
  const json = canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } })
  assert.equal(json, '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}')
})

test('hash does not depend on key insertion order', () => {
  assert.equal(canonicalHash({ a: 1, b: '2' }), canonicalHash({ b: '2', a: 1 }))
  assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: '1' }))
})

test('hash is keccak256 of the UTF-8 canonical string', () => {
  const value = { rationale: 'ETH ₹ breakout', n: 7 }
  assert.equal(canonicalHash(value), keccak256(toBytes('{"n":7,"rationale":"ETH ₹ breakout"}')))
})

test('rejects values JSON cannot represent unambiguously', () => {
  assert.throws(() => canonicalJson({ a: undefined }), /undefined at \$\.a/)
  assert.throws(() => canonicalJson({ a: Number.NaN }), /non-finite/)
  assert.throws(() => canonicalJson({ a: Infinity }), /non-finite/)
  assert.throws(() => canonicalJson({ a: 1n }), /unsupported bigint/)
  assert.throws(() => canonicalJson({ a: new Date(0) }), /non-plain object/)
})

test('idHash hashes the raw id and rejects empty ids', () => {
  assert.equal(idHash('req_1'), keccak256(toBytes('req_1')))
  assert.throws(() => idHash(''), /empty id/)
})
