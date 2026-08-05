import { db, sourceState, lineItems, sourceDocuments } from '@/db'
import { sql } from 'drizzle-orm'
import { Card } from '@/components/ui'
import { SYNCABLE } from '@/lib/sources/registry'
import { recentJobs } from '@/lib/jobs/queue'
import { SourceCard } from './source-card'
import { JobList } from './job-list'

export const dynamic = 'force-dynamic'

export default async function SourcesPage() {
  const [states, jobs, counts, docs] = await Promise.all([
    db.select().from(sourceState),
    recentJobs(15),
    db
      .select({
        source: lineItems.source,
        n: sql<number>`count(*)`,
        latest: sql<string>`max(${lineItems.date})`,
      })
      .from(lineItems)
      .groupBy(lineItems.source),
    db
      .select({
        source: sourceDocuments.source,
        latest: sql<number>`max(${sourceDocuments.ingestedAt})`,
      })
      .from(sourceDocuments)
      .groupBy(sourceDocuments.source),
  ])

  const stateBy = new Map(states.map((s) => [s.source, s]))
  const countBy = new Map(counts.map((c) => [c.source, c]))
  const docBy = new Map(docs.map((d) => [d.source, d]))

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold">Sources</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-3">
          Copilot and Google Cloud sync unattended on a nightly schedule. Amazon
          can&apos;t — its item-level export is a login, an OTP and a 24-hour wait
          — so that one is an upload.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {SYNCABLE.map((a) => (
          <SourceCard
            key={a.id}
            adapter={{
              id: a.id,
              label: a.label,
              archetype: a.archetype,
              connect: a.connect,
            }}
            state={stateBy.get(a.id) ?? null}
            rowCount={Number(countBy.get(a.id)?.n ?? 0)}
            latestData={countBy.get(a.id)?.latest ?? null}
            lastDocAt={docBy.get(a.id)?.latest ?? null}
          />
        ))}
      </div>

      <Card
        title="Jobs"
        subtitle="Nightly sync plus anything you triggered by hand"
      >
        <JobList initial={jobs} />
      </Card>
    </div>
  )
}
