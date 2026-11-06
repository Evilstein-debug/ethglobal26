'use client'

import { explorerTxUrl } from '@starter/shared/chains'
import { useQuery } from '@tanstack/react-query'
import type { Hash } from 'viem'
import { serverUrl, targetChain } from '@/lib/env'

type FeedEntry = { id: number; timestamp: string; message: string; txHash: Hash }

/** Escrow events as seen by apps/server (GET /api/feed), polled every 2s. */
export function Feed() {
  const { data, error } = useQuery({
    queryKey: ['feed'],
    queryFn: async () => {
      const res = await fetch(`${serverUrl}/api/feed?limit=20`)
      return ((await res.json()) as { entries: FeedEntry[] }).entries
    },
    refetchInterval: 2_000,
  })

  if (error) return <p className="text-sm text-bad">Server unreachable at {serverUrl}</p>
  if (!data?.length) return <p className="text-sm text-muted">No activity yet.</p>

  return (
    <ul className="flex flex-col font-mono text-xs">
      {data.map((entry) => {
        const url = explorerTxUrl(targetChain, entry.txHash)
        return (
          <li key={entry.id} className="flex gap-4 border-b border-line py-2 last:border-0">
            <span className="text-muted tabular-nums">
              {new Date(entry.timestamp).toLocaleTimeString()}
            </span>
            <span className="flex-1">{entry.message}</span>
            {url && (
              <a href={url} target="_blank" rel="noreferrer" className="text-muted underline">
                tx ↗
              </a>
            )}
          </li>
        )
      })}
    </ul>
  )
}
