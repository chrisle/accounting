'use client'

import { useEffect, useState } from 'react'
import { Badge } from '@/components/ui'

type Job = {
  id: string
  kind: string
  status: string
  log: string
  error: string | null
  queuedAt: number
  finishedAt: number | null
}

const TONE = {
  ok: 'good',
  error: 'crit',
  running: 'warn',
  queued: 'default',
  cancelled: 'default',
} as const

export function JobList({ initial }: { initial: Job[] }) {
  const [jobs, setJobs] = useState(initial)
  const [open, setOpen] = useState<string | null>(null)

  // Poll only while something is in flight — an idle dashboard shouldn't chat
  // to the server every two seconds forever.
  const active = jobs.some((j) => j.status === 'running' || j.status === 'queued')
  useEffect(() => {
    if (!active) return
    const t = setInterval(async () => {
      const res = await fetch('/api/jobs', { cache: 'no-store' })
      if (res.ok) setJobs(await res.json())
    }, 2000)
    return () => clearInterval(t)
  }, [active])

  if (jobs.length === 0) {
    return <p className="text-sm text-ink-3">No jobs yet.</p>
  }

  return (
    <ul className="divide-y divide-[var(--border)] text-sm">
      {jobs.map((j) => (
        <li key={j.id} className="py-2">
          <button
            onClick={() => setOpen(open === j.id ? null : j.id)}
            className="flex w-full items-center gap-3 text-left"
          >
            <Badge tone={TONE[j.status as keyof typeof TONE] ?? 'default'}>
              {j.status}
            </Badge>
            <span className="font-medium text-ink">{j.kind}</span>
            <span className="ml-auto text-xs text-ink-3">
              {new Date(j.queuedAt * 1000).toLocaleString()}
            </span>
          </button>
          {open === j.id && (
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-surface-2 p-3 text-[11px] leading-relaxed text-ink-2">
              {j.log || '(no output)'}
              {j.error ? `\n\nERROR: ${j.error}` : ''}
            </pre>
          )}
        </li>
      ))}
    </ul>
  )
}
