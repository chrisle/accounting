import { Card, Empty, Stat } from '@/components/ui'
import { ReviewTable } from './review-table'
import { listProjects, reviewQueue, summary } from '@/lib/queries'
import { formatCents } from '@/lib/money'

export const dynamic = 'force-dynamic'

export default async function ReviewPage() {
  const [queue, projects, sum] = await Promise.all([
    reviewQueue(1000),
    listProjects(),
    summary(14),
  ])

  const real = projects.filter((p) => !p.synthetic)

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold">Review queue</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-3">
          Everything the pipeline couldn&apos;t attribute confidently. Assigning a
          project here writes a sticky override keyed to the charge&apos;s identity,
          so a re-sync can never undo it — and optionally a rule, so the next one
          like it never reaches this page.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Needs triage" value={String(queue.length)} />
        <Stat
          label="Unattributed value"
          value={formatCents(sum.unallocatedCents)}
          tone={sum.coverage >= 0.95 ? 'good' : 'warn'}
        />
        <Stat label="Coverage" value={`${(sum.coverage * 100).toFixed(1)}%`} />
      </div>

      {queue.length === 0 ? (
        <Empty
          title="Nothing to review"
          hint="Every charge is attributed with high confidence."
        />
      ) : (
        <Card title={`${queue.length} items`}>
          <ReviewTable items={queue} projects={real} />
        </Card>
      )}
    </div>
  )
}
