'use client'

import { useState, useTransition } from 'react'
import { createRule, deleteRule, toggleRule } from '@/actions/rules'
import { Badge } from '@/components/ui'

type Rule = {
  id: string
  priority: number
  enabled: boolean
  target: string
  scopeSource: string | null
  matchPattern: string
  setProjectId: string | null
  setCategory: string | null
  setCostType: string | null
  note: string | null
}
type Proj = { id: string; name: string; color: string; synthetic: boolean }

export function RuleTable({ rows, projects }: { rows: Rule[]; projects: Proj[] }) {
  const [pending, start] = useTransition()
  const [adding, setAdding] = useState(false)
  const colorOf = (id: string | null) => projects.find((p) => p.id === id)?.color

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <button
          onClick={() => setAdding((a) => !a)}
          className="rounded border border-line px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2"
        >
          {adding ? 'Cancel' : 'New rule'}
        </button>
      </div>

      {adding && (
        <form
          action={createRule}
          className="mb-4 grid grid-cols-2 gap-2 rounded border border-line bg-surface-2 p-3 lg:grid-cols-4"
        >
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            Priority
            <input name="priority" type="number" defaultValue={50} className="rounded border border-line bg-surface-1 px-2 py-1 text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            Target
            <select name="target" className="rounded border border-line bg-surface-1 px-2 py-1 text-ink">
              <option value="transaction">merchant</option>
              <option value="line_item">line item</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            Only source
            <select name="scopeSource" className="rounded border border-line bg-surface-1 px-2 py-1 text-ink">
              <option value="">any</option>
              <option value="amazon">amazon</option>
              <option value="gcp">gcp</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            Project
            <select name="setProjectId" className="rounded border border-line bg-surface-1 px-2 py-1 text-ink">
              <option value="">(leave unset)</option>
              {projects.filter((p) => !p.synthetic).map((p) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="col-span-2 flex flex-col gap-1 text-xs text-ink-3">
            Match (regex, case-insensitive)
            <input name="matchPattern" required placeholder="vercel|netlify" className="rounded border border-line bg-surface-1 px-2 py-1 font-mono text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            Schedule C category
            <input name="setCategory" placeholder="Utilities" className="rounded border border-line bg-surface-1 px-2 py-1 text-ink" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-ink-3">
            Cost type
            <input name="setCostType" placeholder="Hosting" className="rounded border border-line bg-surface-1 px-2 py-1 text-ink" />
          </label>
          <button className="col-span-2 justify-self-start rounded border border-line bg-surface-1 px-3 py-1.5 text-xs font-medium hover:bg-surface-2 lg:col-span-4">
            Create &amp; re-attribute
          </button>
        </form>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-ink-3">
              <th className="pb-2 font-medium">Pri</th>
              <th className="pb-2 font-medium">Target</th>
              <th className="pb-2 font-medium">Match</th>
              <th className="pb-2 font-medium">Project</th>
              <th className="pb-2 font-medium">Category</th>
              <th className="pb-2 font-medium">Cost type</th>
              <th className="pb-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={`border-b border-line/60 last:border-0 ${r.enabled ? '' : 'opacity-40'}`}
              >
                <td className="tnum py-2 text-ink-3">{r.priority}</td>
                <td className="py-2">
                  <Badge>{r.target === 'line_item' ? (r.scopeSource ?? 'item') : 'merchant'}</Badge>
                </td>
                <td className="max-w-[280px] truncate py-2 font-mono text-xs text-ink">
                  {r.matchPattern}
                </td>
                <td className="py-2">
                  {r.setProjectId ? (
                    <span className="flex items-center gap-1.5">
                      <span aria-hidden className="size-2 rounded-[2px]" style={{ background: colorOf(r.setProjectId) }} />
                      <span className="text-ink-2">
                        {projects.find((p) => p.id === r.setProjectId)?.name}
                      </span>
                    </span>
                  ) : (
                    <span className="text-ink-3">—</span>
                  )}
                </td>
                <td className="py-2 text-xs text-ink-3">{r.setCategory ?? '—'}</td>
                <td className="py-2 text-xs text-ink-3">{r.setCostType ?? '—'}</td>
                <td className="py-2 text-right">
                  <button
                    disabled={pending}
                    onClick={() => start(() => toggleRule(r.id, !r.enabled))}
                    className="px-2 text-xs text-ink-3 hover:text-ink"
                  >
                    {r.enabled ? 'disable' : 'enable'}
                  </button>
                  <button
                    disabled={pending}
                    onClick={() => start(() => deleteRule(r.id))}
                    className="px-2 text-xs text-ink-3 hover:text-crit"
                  >
                    delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
