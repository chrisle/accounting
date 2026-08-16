'use client'

import { useEffect, useMemo, useState, useTransition } from 'react'
import { clearLogsAction } from '@/actions/logs'
import { Badge } from '@/components/ui'

type Log = {
  id: string
  ts: number
  level: 'info' | 'warn' | 'error'
  source: string
  message: string
  detail: string | null
}

const TONE = { info: 'default', warn: 'warn', error: 'crit' } as const
type Filter = 'all' | 'info' | 'warn' | 'error'

export function LogList({ initial }: { initial: Log[] }) {
  const [rows, setRows] = useState(initial)
  const [filter, setFilter] = useState<Filter>('all')
  const [open, setOpen] = useState<string | null>(null)
  const [pending, start] = useTransition()

  // Refresh periodically so a sync you triggered shows up without a reload.
  // Cheap: one indexed read of the newest 500 rows.
  useEffect(() => {
    const t = setInterval(async () => {
      const res = await fetch('/api/logs', { cache: 'no-store' })
      if (res.ok) setRows(await res.json())
    }, 5000)
    return () => clearInterval(t)
  }, [])

  const counts = useMemo(() => {
    const c = { all: rows.length, info: 0, warn: 0, error: 0 }
    for (const r of rows) c[r.level]++
    return c
  }, [rows])

  const shown = filter === 'all' ? rows : rows.filter((r) => r.level === filter)

  return (
    <div>
      <div className="mb-3 flex items-center gap-1">
        {(['all', 'info', 'warn', 'error'] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-md px-2.5 py-1 text-xs font-medium capitalize transition-colors ${
              filter === f
                ? 'bg-surface-2 text-ink'
                : 'text-ink-3 hover:bg-surface-2 hover:text-ink-2'
            }`}
          >
            {f}
            <span className="tnum ml-1.5 text-ink-3">{counts[f]}</span>
          </button>
        ))}
        <button
          onClick={() => {
            if (confirm('Clear all logs?')) start(() => clearLogsAction().then(() => setRows([])))
          }}
          disabled={pending || rows.length === 0}
          className="ml-auto rounded-md px-2.5 py-1 text-xs text-ink-3 hover:text-crit disabled:opacity-40"
        >
          Clear
        </button>
      </div>

      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-ink-3">Nothing logged yet.</p>
      ) : (
        <ul className="divide-y divide-[var(--border)] font-mono text-xs">
          {shown.map((r) => (
            <li key={r.id} className="py-1.5">
              <button
                onClick={() => r.detail && setOpen(open === r.id ? null : r.id)}
                className={`flex w-full items-baseline gap-3 text-left ${r.detail ? 'cursor-pointer' : 'cursor-default'}`}
              >
                <Badge tone={TONE[r.level]}>{r.level}</Badge>
                <span className="tnum shrink-0 text-ink-3">
                  {new Date(r.ts * 1000).toLocaleString()}
                </span>
                <span className="shrink-0 text-ink-2">{r.source}</span>
                <span className="truncate text-ink">{r.message}</span>
              </button>
              {open === r.id && r.detail && (
                <pre className="mt-1.5 max-h-64 overflow-auto rounded bg-surface-2 p-3 leading-relaxed text-ink-2">
                  {r.detail}
                </pre>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
