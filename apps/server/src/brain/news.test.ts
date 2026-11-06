import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, test } from 'node:test'
import { newsReader, parseTitles } from './news'

const rss = `<rss><channel><title>The feed itself</title>
  <item><title><![CDATA[ETH &amp; friends rally]]></title><link>x</link></item>
  <item><title>Fed holds <b>rates</b></title></item>
  <item><title>  </title></item>
</channel></rss>`

test('parseTitles: RSS and Atom, cleaned, without the feed title', () => {
  assert.deepEqual(parseTitles(rss), ['ETH & friends rally', 'Fed holds rates'])
  assert.deepEqual(parseTitles('<feed><title>f</title><entry><title>A</title></entry></feed>'), [
    'A',
  ])
  assert.deepEqual(parseTitles('not xml'), [])
  assert.equal(parseTitles(`<item><title>${'x'.repeat(500)}</title></item>`)[0]!.length, 200)
})

test('live feed, cached for a minute, falling back to the labeled fixture', async () => {
  let hits = 0
  let up = true
  const server = createServer((_req, res) => {
    hits++
    res.statusCode = up ? 200 : 500
    res.end(rss)
  }).listen(0)
  after(() => server.close())
  await new Promise((r) => server.once('listening', r))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`
  let clock = 0

  const read = newsReader([url], () => clock)
  const live = await read()
  assert.equal(live.label, 'live RSS headlines')
  assert.equal(live.items.length, 2)
  await read()
  assert.equal(hits, 1, 'served from cache')

  up = false
  clock = 60_001
  const fallback = await read()
  assert.notEqual(fallback.label, 'live RSS headlines')
  assert.ok(fallback.items.length > 0)

  const none = await newsReader([])()
  assert.deepEqual(none, fallback)
})
