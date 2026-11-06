import type { ComponentProps, ReactNode } from 'react'

// The whole design system: square edges, 1px lines, monochrome.

export function Button({
  className = '',
  variant = 'solid',
  ...props
}: ComponentProps<'button'> & { variant?: 'solid' | 'outline' }) {
  const look =
    variant === 'solid'
      ? 'bg-fg text-bg hover:opacity-85'
      : 'border border-fg text-fg hover:bg-fg hover:text-bg'
  return (
    <button
      className={`h-10 px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-40 ${look} ${className}`}
      {...props}
    />
  )
}

export function Field({ label, ...props }: ComponentProps<'input'> & { label: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted uppercase tracking-widest">{label}</span>
      <input
        className="h-10 border border-line bg-transparent px-3 font-mono text-sm outline-none focus:border-fg"
        {...props}
      />
    </label>
  )
}

export function Panel({
  title,
  className = '',
  children,
}: {
  title: string
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`flex flex-col gap-4 bg-bg p-6 ${className}`}>
      <h2 className="text-xs text-muted uppercase tracking-widest">{title}</h2>
      {children}
    </section>
  )
}

export const short = (value: string) => `${value.slice(0, 6)}…${value.slice(-4)}`

export function Badge({
  children,
  tone = 'muted',
}: {
  children: ReactNode
  tone?: 'ok' | 'bad' | 'muted'
}) {
  const color =
    tone === 'ok'
      ? 'border-ok text-ok'
      : tone === 'bad'
        ? 'border-bad text-bad'
        : 'border-line text-muted'
  return (
    <span className={`inline-block border px-1.5 py-0.5 font-mono text-[10px] uppercase ${color}`}>
      {children}
    </span>
  )
}

export function Select({
  label,
  children,
  ...props
}: ComponentProps<'select'> & { label: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs text-muted uppercase tracking-widest">{label}</span>
      <select
        className="h-10 border border-line bg-transparent px-3 text-sm outline-none focus:border-fg"
        {...props}
      >
        {children}
      </select>
    </label>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted">{children}</p>
}
