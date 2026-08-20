'use client'

import { useMemo, useState, useTransition } from 'react'
import {
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table'
import { assignProject } from '@/actions/attribution'
import { Badge } from '@/components/ui'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/table'
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
type Scope = 'this_charge' | 'this_merchant' | 'this_item'

export function ReviewTable({ items, projects }: { items: Item[]; projects: Proj[] }) {
  const [pending, start] = useTransition()
  const [done, setDone] = useState<Set<string>>(new Set())
  const [scope, setScope] = useState<Record<string, Scope>>({})
  const [makeRule, setMakeRule] = useState(true)
  const [sorting, setSorting] = useState<SortingState>([{ id: 'cents', desc: false }])
  const [filter, setFilter] = useState('')

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

  // Assigned rows leave the table immediately; re-querying 600 rows to drop one
  // is a round trip the user would feel on every click.
  const data = useMemo(() => items.filter((i) => !done.has(i.allocationId)), [items, done])

  const columns = useMemo<ColumnDef<Item>[]>(
    () => [
      {
        accessorKey: 'date',
        header: 'Date',
        cell: ({ row }) => <span className="tnum text-xs text-ink-3">{row.original.date}</span>,
      },
      {
        id: 'charge',
        accessorFn: (r) => `${r.description ?? ''} ${r.merchant}`,
        header: 'Charge',
        cell: ({ row }) => {
          const it = row.original
          return (
            <div className="min-w-0">
              <div className="truncate font-medium text-ink">
                {it.description ?? it.merchant}
              </div>
              {it.description && (
                <div className="truncate text-xs text-ink-3">{it.merchant}</div>
              )}
            </div>
          )
        },
      },
      {
        accessorKey: 'source',
        header: 'Source',
        cell: ({ row }) =>
          row.original.source ? <Badge>{row.original.source}</Badge> : null,
      },
      {
        accessorKey: 'confidence',
        header: 'Confidence',
        cell: ({ row }) => {
          const it = row.original
          if (it.confidence >= 0.8 || it.provenance === 'fallback') return null
          return <Badge tone="warn">{(it.confidence * 100).toFixed(0)}%</Badge>
        },
      },
      {
        accessorKey: 'cents',
        header: () => <div className="text-right">Amount</div>,
        cell: ({ row }) => (
          <div className="tnum text-right font-semibold text-ink">
            {formatCents(Math.abs(row.original.cents))}
          </div>
        ),
      },
      {
        id: 'assign',
        header: 'Assign to',
        enableSorting: false,
        cell: ({ row }) => {
          const it = row.original
          const s = scope[it.allocationId] ?? (it.lineItemId ? 'this_item' : 'this_merchant')
          return (
            <div className="flex flex-wrap items-center gap-1.5">
              <select
                value={s}
                onChange={(e) =>
                  setScope((p) => ({ ...p, [it.allocationId]: e.target.value as Scope }))
                }
                className="rounded border border-line bg-surface-2 px-2 py-1 text-xs text-ink-2"
              >
                {it.lineItemId && <option value="this_item">this item</option>}
                <option value="this_merchant">this merchant</option>
                <option value="this_charge">this charge only</option>
              </select>
              <span className="text-xs text-ink-3">→</span>
              {projects.length === 0 && (
                <span className="text-xs text-ink-3">no projects yet</span>
              )}
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
          )
        },
      },
    ],
    // assign closes over pending/scope, both of which change per interaction.
    [projects, pending, scope, makeRule],
  )

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter: filter },
    onSortingChange: setSorting,
    onGlobalFilterChange: setFilter,
    getRowId: (r) => r.allocationId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    initialState: { pagination: { pageSize: 25 } },
  })

  const rows = table.getRowModel().rows
  const filtered = table.getFilteredRowModel().rows.length

  return (
    <div className="flex flex-col gap-3">
      {projects.length === 0 && (
        <p className="rounded border border-line bg-surface-2 px-3 py-2 text-xs text-ink-2">
          Nothing can be assigned until a project exists —{' '}
          <a href="/projects" className="underline hover:text-ink">
            create one on Projects
          </a>
          , then come back.
        </p>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter charges…"
          className="w-56 rounded border border-line bg-surface-2 px-2.5 py-1.5 text-xs text-ink placeholder:text-ink-3"
        />
        <label className="flex items-center gap-2 text-xs text-ink-2">
          <input
            type="checkbox"
            checked={makeRule}
            onChange={(e) => setMakeRule(e.target.checked)}
            className="accent-[var(--text-primary)]"
          />
          Also create a rule, so future charges like this attribute automatically
        </label>
      </div>

      <Table>
        <TableHeader>
          {table.getHeaderGroups().map((hg) => (
            <TableRow key={hg.id}>
              {hg.headers.map((h) => {
                const sortable = h.column.getCanSort()
                const dir = h.column.getIsSorted()
                return (
                  <TableHead key={h.id}>
                    {h.isPlaceholder ? null : sortable ? (
                      <button
                        onClick={h.column.getToggleSortingHandler()}
                        className="flex items-center gap-1 uppercase tracking-wide hover:text-ink-2"
                      >
                        {flexRender(h.column.columnDef.header, h.getContext())}
                        <span aria-hidden className="text-[10px]">
                          {dir === 'asc' ? '▲' : dir === 'desc' ? '▼' : '↕'}
                        </span>
                      </button>
                    ) : (
                      flexRender(h.column.columnDef.header, h.getContext())
                    )}
                  </TableHead>
                )
              })}
            </TableRow>
          ))}
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="py-8 text-center text-ink-3">
                {data.length === 0
                  ? 'Queue cleared. Reload to pick up anything new.'
                  : 'Nothing matches that filter.'}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((row) => (
              <TableRow key={row.id}>
                {row.getVisibleCells().map((cell) => (
                  <TableCell key={cell.id}>
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      <div className="flex flex-wrap items-center justify-between gap-3 text-xs text-ink-3">
        <span className="tnum">
          {filtered} row{filtered === 1 ? '' : 's'}
          {filter && ` of ${data.length}`} · page{' '}
          {table.getState().pagination.pageIndex + 1} of {table.getPageCount() || 1}
        </span>
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
            className="rounded border border-line px-2 py-1 transition-colors hover:border-line-strong hover:bg-surface-2 disabled:opacity-40"
          >
            Previous
          </button>
          <button
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
            className="rounded border border-line px-2 py-1 transition-colors hover:border-line-strong hover:bg-surface-2 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  )
}
