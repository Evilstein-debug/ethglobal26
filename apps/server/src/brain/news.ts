/**
 * What agents read. With NEWS_RSS_URLS set, live headlines; otherwise, or if every feed fails, the
 * labeled fixture file. Headlines are untrusted DATA: only titles are kept, they're capped, and the
 * model only ever sees them as data.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

export type News = { label: string; items: string[] }

const MAX_ITEMS = 10
const MAX_CHARS = 200
const TIMEOUT_MS = 5000
const CACHE_MS = 60_000

const FIXTURE = JSON.parse(
  readFileSync(resolve(import.meta.dirname, '../../fixtures/headlines.json'), 'utf8'),
) as News

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  '#39': "'",
}

/** Titles of an RSS or Atom feed, skipping the feed's own title. */
export function parseTitles(xml: string): string[] {
  const entries = xml.match(/<(item|entry)[\s>][\s\S]*?<\/\1>/g) ?? []
  return entries.flatMap((entry) => {
    const raw = /<title[^>]*>([\s\S]*?)<\/title>/.exec(entry)?.[1] ?? ''
    const title = raw
      .replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1')
      .replace(/<[^>]*>/g, '')
      .replace(/&(#39|\w+);/g, (m, name: string) => ENTITIES[name] ?? m)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_CHARS)
    return title ? [title] : []
  })
}

async function readFeed(url: string) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { 'user-agent': 'AgentArena/1.0 (+RSS reader)' },
  })
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  return parseTitles(await res.text())
}

export function newsReader(urls: string[], now: () => number = Date.now) {
  let cache: { at: number; news: News } | null = null
  return async (): Promise<News> => {
    if (!urls.length) return FIXTURE
    if (cache && now() - cache.at < CACHE_MS) return cache.news
    const feeds = await Promise.allSettled(urls.map(readFeed))
    for (const f of feeds) if (f.status === 'rejected') console.error('[news]', f.reason)
    const items = [...new Set(feeds.flatMap((f) => (f.status === 'fulfilled' ? f.value : [])))]
    const news = items.length
      ? { label: 'live RSS headlines', items: items.slice(0, MAX_ITEMS) }
      : FIXTURE
    cache = { at: now(), news }
    return news
  }
}
