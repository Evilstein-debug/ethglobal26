import type { ComponentProps, ReactNode } from 'react'

// App primitives in the DESIGN.md language: 8px buttons and inputs, 12px cards, hairline borders,
// editorial serif for page titles, Raycast colours in light mode.

export function Button({
  className = '',
  variant = 'solid',
  ...props
}: ComponentProps<'button'> & { variant?: 'solid' | 'outline' }) {
  const look =
    variant === 'solid'
      ? 'bg-primary text-on-primary hover:bg-primary-pressed'
      : 'border border-hairline-strong bg-card text-ink hover:bg-elevated'
  return (
    <button
      className={`inline-flex h-10 items-center justify-center gap-2 rounded-lg px-5 text-sm font-medium transition-colors duration-150 disabled:cursor-not-allowed disabled:opacity-40 ${look} ${className}`}
      {...props}
    />
  )
}

const control =
  'h-11 rounded-lg border border-hairline-strong bg-card px-3.5 text-[15px] text-ink outline-none transition-shadow placeholder:text-ash focus:border-ink focus:ring-2 focus:ring-ink/10'

export function Field({ label, ...props }: ComponentProps<'input'> & { label: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-body">{label}</span>
      <input className={`${control} font-mono`} {...props} />
    </label>
  )
}

export function Select({
  label,
  children,
  ...props
}: ComponentProps<'select'> & { label: string }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-[13px] font-medium text-body">{label}</span>
      <select className={control} {...props}>
        {children}
      </select>
    </label>
  )
}

/** Section eyebrow: 11px uppercase, tracked. */
export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <p className={`text-[11px] font-semibold tracking-[1px] text-mute uppercase ${className}`}>
      {children}
    </p>
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
    <section
      className={`flex min-w-0 flex-col gap-4 rounded-xl border border-hairline bg-card p-6 ${className}`}
    >
      <h2 className="text-[11px] font-semibold tracking-[1px] text-mute uppercase">{title}</h2>
      {children}
    </section>
  )
}

/** Page opener: eyebrow, editorial serif title, lead paragraph, optional actions on the right. */
export function PageHeader({
  eyebrow,
  title,
  children,
  actions,
}: {
  eyebrow?: string
  title: ReactNode
  children?: ReactNode
  actions?: ReactNode
}) {
  return (
    <header className="flex flex-col justify-between gap-6 border-b border-hairline pb-8 md:flex-row md:items-end">
      <div className="flex max-w-[720px] flex-col gap-3">
        {eyebrow && <Eyebrow>{eyebrow}</Eyebrow>}
        <h1 className="font-display text-[40px] leading-[1.1] tracking-[-1px] text-ink md:text-[52px]">
          {title}
        </h1>
        {children && <div className="text-[16px] leading-[1.55] text-body">{children}</div>}
      </div>
      {actions && <div className="flex flex-wrap gap-3">{actions}</div>}
    </header>
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
      ? 'bg-accent-green/12 text-accent-green'
      : tone === 'bad'
        ? 'bg-accent-red/12 text-accent-red'
        : 'bg-chip text-body'
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[12px] font-semibold whitespace-nowrap ${color}`}
    >
      {children}
    </span>
  )
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="text-[15px] leading-[1.55] text-mute">{children}</p>
}

/** Full-width notice: warnings (replay data, local-only tools) and info. */
export function Notice({
  children,
  tone = 'muted',
}: {
  children: ReactNode
  tone?: 'bad' | 'muted'
}) {
  const look =
    tone === 'bad'
      ? 'border-accent-red/30 bg-accent-red/5 text-accent-red'
      : 'border-hairline bg-surface text-body'
  return <div className={`rounded-lg border px-4 py-3 text-sm ${look}`}>{children}</div>
}
