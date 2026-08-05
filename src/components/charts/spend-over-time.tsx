'use client'

import { useMemo, useState } from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { money, pickColor, useIsDark, type SeriesMeta } from './use-theme'

type Row = { month: string } & Record<string, number | string>

/**
 * Change over time, composed of parts -> stacked bars on one axis.
 *
 * Segments carry a 2px stroke in the surface colour: that's the spacer rule,
 * and it's what stops adjacent hues from bleeding into each other. Series are
 * bound to project ids, so toggling one in the legend never repaints the rest.
 */
export function SpendOverTime({
  data,
  series,
  height = 320,
}: {
  data: Row[]
  series: SeriesMeta[]
  height?: number
}) {
  const dark = useIsDark()
  const [hidden, setHidden] = useState<Set<string>>(new Set())

  const visible = useMemo(
    () => series.filter((s) => !hidden.has(s.id)),
    [series, hidden],
  )

  const toggle = (id: string) =>
    setHidden((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  const fmtMonth = (m: string) => {
    const [y, mm] = m.split('-')
    const label = new Date(Number(y), Number(mm) - 1, 1).toLocaleDateString('en-US', {
      month: 'short',
    })
    return mm === '01' ? `${label} ${y.slice(2)}` : label
  }

  return (
    <div>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
          <CartesianGrid strokeDasharray="0" vertical={false} />
          <XAxis
            dataKey="month"
            tickFormatter={fmtMonth}
            tickLine={false}
            axisLine={false}
            fontSize={11}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={(v) => money(Number(v), true)}
            tickLine={false}
            axisLine={false}
            width={58}
            fontSize={11}
          />
          <Tooltip
            cursor={{ fill: 'var(--surface-2)' }}
            content={({ active, payload, label }) => {
              if (!active || !payload?.length) return null
              const rows = [...payload].filter((p) => Number(p.value) > 0).reverse()
              const total = rows.reduce((a, p) => a + Number(p.value), 0)
              return (
                <div className="card min-w-[190px] p-3 text-xs shadow-lg">
                  <div className="mb-2 font-medium text-ink">
                    {fmtMonth(String(label))}
                  </div>
                  {rows.map((p) => (
                    <div key={p.dataKey} className="flex items-center gap-2 py-0.5">
                      <span
                        aria-hidden
                        className="size-2.5 shrink-0 rounded-[3px]"
                        style={{ background: p.color }}
                      />
                      <span className="text-ink-2">
                        {series.find((s) => s.id === p.dataKey)?.name}
                      </span>
                      <span className="tnum ml-auto text-ink">
                        {money(Number(p.value))}
                      </span>
                    </div>
                  ))}
                  <div className="mt-2 flex justify-between border-t border-line pt-2 font-medium">
                    <span className="text-ink-2">Total</span>
                    <span className="tnum text-ink">{money(total)}</span>
                  </div>
                </div>
              )
            }}
          />
          {visible.map((s, i) => (
            <Bar
              key={s.id}
              dataKey={s.id}
              stackId="spend"
              fill={pickColor(s, dark)}
              // 2px surface gap between stacked segments.
              stroke="var(--surface-1)"
              strokeWidth={2}
              radius={i === visible.length - 1 ? [4, 4, 0, 0] : 0}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>

      {/* Legend is always present for >= 2 series — identity is never colour alone. */}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {series.map((s) => {
          const off = hidden.has(s.id)
          return (
            <li key={s.id}>
              <button
                onClick={() => toggle(s.id)}
                aria-pressed={!off}
                className={`flex items-center gap-1.5 text-xs transition-opacity ${
                  off ? 'opacity-35' : ''
                }`}
              >
                <span
                  aria-hidden
                  className="size-2.5 rounded-[3px]"
                  style={{ background: pickColor(s, dark) }}
                />
                <span className="text-ink-2">{s.name}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
