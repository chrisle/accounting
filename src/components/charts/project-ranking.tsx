'use client'

import Link from 'next/link'
import { money, pickColor, useIsDark, type SeriesMeta } from './use-theme'

export type RankRow = SeriesMeta & { cents: number; txnCount: number }

/**
 * Ranked magnitude across a handful of categories -> horizontal bars, sorted,
 * directly labelled. No pie: comparing angles is strictly worse than comparing
 * lengths, and the values are already known here.
 *
 * Doubles as the table view the light-mode contrast WARN obliges: every value
 * is visible as text, not just as a colour.
 */
export function ProjectRanking({ rows }: { rows: RankRow[] }) {
  const dark = useIsDark()
  const max = Math.max(...rows.map((r) => Math.abs(r.cents)), 1)
  const total = rows.reduce((a, r) => a + Math.abs(r.cents), 0)

  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => {
        const v = Math.abs(r.cents)
        const pct = total > 0 ? (v / total) * 100 : 0
        return (
          <li key={r.id}>
            <Link
              href={`/projects/${r.id}`}
              className="group block rounded-md p-1.5 transition-colors hover:bg-surface-2"
            >
              <div className="mb-1 flex items-baseline gap-2 text-xs">
                <span
                  aria-hidden
                  className="size-2.5 shrink-0 rounded-[3px]"
                  style={{ background: pickColor(r, dark) }}
                />
                <span className="font-medium text-ink">{r.name}</span>
                <span className="text-ink-3">{pct.toFixed(0)}%</span>
                <span className="tnum ml-auto font-medium text-ink">
                  {money(v / 100)}
                </span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full"
                  style={{
                    width: `${(v / max) * 100}%`,
                    background: pickColor(r, dark),
                  }}
                />
              </div>
            </Link>
          </li>
        )
      })}
    </ul>
  )
}
