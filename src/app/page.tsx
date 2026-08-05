import Link from 'next/link'
import { Card, Empty, Stat } from '@/components/ui'
import { ProjectRanking } from '@/components/charts/project-ranking'
import { SpendOverTime } from '@/components/charts/spend-over-time'
import {
  invariantBreaches,
  listProjects,
  spendByMonth,
  spendByProject,
  summary,
} from '@/lib/queries'
import { formatCents } from '@/lib/money'
import { UNALLOCATED } from '@/db/schema'

export const dynamic = 'force-dynamic'

export default async function OverviewPage() {
  const [monthly, byProject, sum, projects, breaches] = await Promise.all([
    spendByMonth(14),
    spendByProject(14),
    summary(14),
    listProjects(),
    invariantBreaches(),
  ])

  if (sum.txnCount === 0) {
    return (
      <Empty
        title="No cost data yet"
        hint={
          <>
            Connect Copilot Money on the{' '}
            <Link href="/sources" className="underline">
              Sources
            </Link>{' '}
            page, or run <code className="text-ink-2">npm run db:seed</code> to
            populate 14 months of demo data.
          </>
        }
      />
    )
  }

  const meta = new Map(projects.map((p) => [p.id, p]))
  const series = monthly.projectIds
    .map((id) => meta.get(id))
    .filter((p): p is NonNullable<typeof p> => !!p)
    // Unallocated stacks last so the real projects sit on the baseline where
    // they're easiest to compare.
    .sort((a, b) => (a.synthetic ? 1 : 0) - (b.synthetic ? 1 : 0) || a.sortOrder - b.sortOrder)
    .map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      colorDark: p.colorDark,
      synthetic: p.synthetic,
    }))

  const ranking = byProject
    .filter((r) => r.projectId !== UNALLOCATED)
    .map((r) => {
      const m = meta.get(r.projectId)!
      return {
        id: r.projectId,
        name: r.name,
        color: m.color,
        colorDark: m.colorDark,
        cents: r.cents,
        txnCount: r.txnCount,
      }
    })

  const coveragePct = (sum.coverage * 100).toFixed(1)
  const coverageTone =
    sum.coverage >= 0.95 ? 'good' : sum.coverage >= 0.8 ? 'warn' : 'crit'

  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat
          label="Spend, 14 months"
          value={formatCents(sum.totalCents)}
          hint={`${sum.txnCount} charges · ${sum.allocCount} allocations`}
        />
        <Stat
          label="This month"
          value={formatCents(sum.thisMonthCents)}
          hint="month to date"
        />
        <Stat
          label="Attributed"
          value={`${coveragePct}%`}
          tone={coverageTone}
          hint={
            <Link href="/review" className="underline">
              {formatCents(sum.unallocatedCents)} needs triage →
            </Link>
          }
        />
        <Stat
          label="Reconciliation"
          value={breaches.length === 0 ? 'Balanced' : `${breaches.length} off`}
          tone={breaches.length === 0 ? 'good' : 'crit'}
          hint="allocations vs. bank charges"
        />
      </div>

      <Card
        title="Spend over time, by project"
        subtitle="Every bar sums to what actually hit the account — unattributed cost is shown, not hidden."
      >
        <SpendOverTime data={monthly.data} series={series} height={340} />
      </Card>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title="By project" subtitle="Last 14 months · click to drill in">
          {ranking.length > 0 ? (
            <ProjectRanking rows={ranking} />
          ) : (
            <p className="text-sm text-ink-3">Nothing attributed yet.</p>
          )}
        </Card>

        <Card
          title="Where the money went"
          subtitle="Full table — every value readable as text, not colour"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left text-xs text-ink-3">
                  <th className="pb-2 font-medium">Project</th>
                  <th className="pb-2 text-right font-medium">Charges</th>
                  <th className="pb-2 text-right font-medium">Spend</th>
                </tr>
              </thead>
              <tbody>
                {byProject.map((r) => (
                  <tr key={r.projectId} className="border-b border-line/60 last:border-0">
                    <td className="py-2">
                      <Link
                        href={`/projects/${r.projectId}`}
                        className="flex items-center gap-2 hover:underline"
                      >
                        <span
                          aria-hidden
                          className="size-2.5 rounded-[3px]"
                          style={{ background: meta.get(r.projectId)?.color }}
                        />
                        <span className={r.synthetic ? 'text-ink-3' : 'text-ink'}>
                          {r.name}
                        </span>
                      </Link>
                    </td>
                    <td className="tnum py-2 text-right text-ink-3">{r.txnCount}</td>
                    <td className="tnum py-2 text-right font-medium text-ink">
                      {formatCents(r.cents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>

      {breaches.length > 0 && (
        <Card
          title="Reconciliation breaches"
          subtitle="Allocations that don't sum to the charge. Any row here is a bug in the pipeline, not a data problem."
        >
          <table className="w-full text-sm">
            <tbody>
              {breaches.map((b) => (
                <tr key={b.txnId} className="border-b border-line/60 last:border-0">
                  <td className="py-1.5 text-ink-3">{b.date}</td>
                  <td className="py-1.5">{b.merchant}</td>
                  <td className="tnum py-1.5 text-right">{formatCents(b.txnCents)}</td>
                  <td className="tnum py-1.5 text-right text-crit">
                    {formatCents(b.allocCents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  )
}
