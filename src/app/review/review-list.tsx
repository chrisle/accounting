'use client'

import { useState, useTransition } from 'react'
import { assignProject } from '@/actions/attribution'
import { Badge } from '@/components/ui'
import { formatCents } from '@/lib/money'

type Item = {
  allocationId: string
  txnId: string
  lineItemId: string | null
  date: string
  merchant: string
  merchantNorm: string
  description: string | null
  source: string | null
  cents: number
  projectId: string
  confidence: number
  provenance: string
}

type Proj = { id: string; name: string; color: string }

export function ReviewList({ items, projects }: { items: Item[]; projects: Proj[] }) {
  const [pending, start] = useTransition()
  const [done, setDone] = useState<Set<string>>(new Set())
  const [scope, setScope] = useState<Record<string, 'this_charge' | 'this_merchant' | 'this_item'>>({})
  const [makeRule, setMakeRule] = useState(true)

  const assign = (it: Item, projectId: string) => {
    const s = scope[it.allocationId] ?? (it.lineItemId ? 'this_item' : 'this_merchant')
    start(async () => {
      await assignProject({
        txnId: it.txnId,
        lineItemId: it.lineItemId,
        projectId,
        scope: s,
        alsoCreateRule: makeRule,
      })
      setDone((p) => new Set(p).add(it.allocationId))
    })
  }

  const visible = items.filter((i) => !done.has(i.allocationId))

  return (
    <div>
      <label className="mb-3 flex items-center gap-2 text-xs text-ink-2">
        <input
          type="checkbox"
          checked={makeRule}
          onChange={(e) => setMakeRule(e.target.checked)}
          className="accent-[var(--text-primary)]"
        />
        Also create a rule, so future charges like this attribute automatically
      </label>

      <ul className="flex flex-col divide-y divide-[var(--border)]">
        {visible.map((it) => {
          const s = scope[it.allocationId] ?? (it.lineItemId ? 'this_item' : 'this_merchant')
          return (
            <li key={it.allocationId} className="py-3">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="text-xs text-ink-3">{it.date}</span>
                <span className="font-medium text-ink">
                  {it.description ?? it.merchant}
                </span>
                {it.source && <Badge>{it.source}</Badge>}
                {it.confidence < 0.8 && it.provenance !== 'fallback' && (
                  <Badge tone="warn">
                    {(it.confidence * 100).toFixed(0)}% confident
                  </Badge>
                )}
                <span className="tnum ml-auto font-semibold text-ink">
                  {formatCents(Math.abs(it.cents))}
                </span>
              </div>

              {it.description && (
                <div className="mt-0.5 text-xs text-ink-3">{it.merchant}</div>
              )}

              <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                <select
                  value={s}
                  onChange={(e) =>
                    setScope((p) => ({ ...p, [it.allocationId]: e.target.value as never }))
                  }
                  className="rounded border border-line bg-surface-2 px-2 py-1 text-xs text-ink-2"
                >
                  {it.lineItemId && <option value="this_item">this item</option>}
                  <option value="this_merchant">this merchant</option>
                  <option value="this_charge">this charge only</option>
                </select>

                <span className="text-xs text-ink-3">→</span>

                {projects.map((p) => (
                  <button
                    key={p.id}
                    disabled={pending}
                    onClick={() => assign(it, p.id)}
                    className="flex items-center gap-1.5 rounded border border-line px-2 py-1 text-xs text-ink-2 transition-colors hover:border-line-strong hover:bg-surface-2 disabled:opacity-40"
                  >
                    <span
                      aria-hidden
                      className="size-2 rounded-[2px]"
                      style={{ background: p.color }}
                    />
                    {p.name}
                  </button>
                ))}
              </div>
            </li>
          )
        })}
      </ul>

      {visible.length === 0 && (
        <p className="py-6 text-center text-sm text-ink-3">
          Queue cleared. Reload to pick up anything new.
        </p>
      )}
    </div>
  )
}
