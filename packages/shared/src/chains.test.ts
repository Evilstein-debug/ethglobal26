import assert from 'node:assert/strict'
import { test } from 'node:test'
import { explorerTxUrl, getChain, parseChainId, resolveRpcUrl } from './chains'

test('parseChainId defaults to local anvil and rejects unknown chains', () => {
  assert.equal(parseChainId(undefined), 31337)
  assert.equal(parseChainId('11155111'), 11155111)
  assert.throws(() => parseChainId('999999999'), /Unsupported chain ID/)
})

test('rpc override wins over the default', () => {
  const chain = getChain(31337)
  assert.equal(resolveRpcUrl(chain, 'http://example.test'), 'http://example.test')
  assert.equal(resolveRpcUrl(chain), chain.rpcUrls.default.http[0])
})

test('explorer links exist only where an explorer is configured', () => {
  const hash = `0x${'ab'.repeat(32)}` as const
  assert.equal(explorerTxUrl(getChain(31337), hash), undefined)
  assert.match(explorerTxUrl(getChain(11155111), hash)!, /\/tx\/0xabab/)
})
