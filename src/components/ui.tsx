import type { ReactNode } from 'react'

export function Card({
  title,
  subtitle,
  action,
  children,
  className = '',
}: {
  title?: ReactNode
  subtitle?: ReactNode
  action?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`card p-5 ${className}`}>
      {(title || action) && (
        <header className="mb-4 flex items-start justify-between gap-4">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-ink-3">{subtitle}</p>}
          </div>
          {action}
        </header>
      )}
      {children}
    </section>
  )
}

/**
 * A single number is a stat tile, not a chart — no plot, no axes, no legend.
 * `hint` carries the comparison that makes the number mean something.
 */
export function Stat({
  label,
  value,
  hint,
  tone = 'default',
}: {
  label: string
  value: string
  hint?: ReactNode
  tone?: 'default' | 'good' | 'warn' | 'crit'
}) {
  const toneClass = {
    default: 'text-ink',
    good: 'text-good',
    warn: 'text-warn',
    crit: 'text-crit',
  }[tone]

  return (
    <div className="card p-5">
      <div className="text-xs font-medium uppercase tracking-wide text-ink-3">
        {label}
      </div>
      <div className={`tnum mt-2 text-3xl font-semibold ${toneClass}`}>{value}</div>
      {hint && <div className="mt-1.5 text-xs text-ink-3">{hint}</div>}
    </div>
  )
}

export function Swatch({ color, label }: { color: string; label?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className="inline-block size-2.5 shrink-0 rounded-[3px]"
        style={{ background: color }}
      />
      {label && <span className="text-ink-2">{label}</span>}
    </span>
  )
}

export function Badge({
  children,
  tone = 'default',
}: {
  children: ReactNode
  tone?: 'default' | 'good' | 'warn' | 'crit'
}) {
  const cls = {
    default: 'border-line text-ink-3',
    good: 'border-good/40 text-good',
    warn: 'border-warn/40 text-warn',
    crit: 'border-crit/40 text-crit',
  }[tone]
  return (
    <span
      className={`inline-flex items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${cls}`}
    >
      {children}
    </span>
  )
}

export function Empty({ title, hint }: { title: string; hint?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center justify-center gap-1.5 p-12 text-center">
      <p className="text-sm font-medium text-ink-2">{title}</p>
      {hint && <p className="max-w-md text-xs text-ink-3">{hint}</p>}
    </div>
  )
}
