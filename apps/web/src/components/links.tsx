import { explorerTxUrl } from '@starter/shared/chains'
import type { Hash } from 'viem'
import { Badge, short } from '@/components/ui'
import { targetChain } from '@/lib/env'

export function TxLink({ hash, label }: { hash: string | null | undefined; label?: string }) {
  if (!hash) return <span className="text-mute">—</span>
  const url =
    hash.startsWith('0x') && hash.length === 66
      ? explorerTxUrl(targetChain, hash as Hash)
      : undefined
  return url ? (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      className="font-mono text-ink underline decoration-hairline-strong underline-offset-4 hover:decoration-ink"
    >
      {label ?? short(hash)} ↗
    </a>
  ) : (
    <span className="font-mono">{label ?? short(hash)}</span>
  )
}

export function ModelBadge({ d }: { d: { model: string; teeVerified: boolean | null } }) {
  if (d.model === 'local-stub') return <Badge tone="bad">local stub</Badge>
  if (d.model === 'manual') return <Badge>manual</Badge>
  return (
    <Badge tone={d.teeVerified ? 'ok' : 'bad'}>
      {d.model} · {d.teeVerified ? 'TEE ✓' : 'unverified'}
    </Badge>
  )
}
