import { asc } from 'drizzle-orm'
import { db, rules } from '@/db'
import { Badge, Card } from '@/components/ui'
import { listProjects } from '@/lib/queries'
import { RuleTable } from './rule-table'
import { configDir } from '@/lib/paths'

export const dynamic = 'force-dynamic'

export default async function RulesPage() {
  const [rows, projects] = await Promise.all([
    db.select().from(rules).orderBy(asc(rules.priority)),
    listProjects(),
  ])

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold">Rules</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-3">
          Deterministic attribution, lowest priority number first. Fields fill in
          independently, so a broad rule can supply the cost type that a narrow
          project rule left blank. Every change is mirrored to{' '}
          <code className="text-ink-2">{configDir()}/rules.yaml</code> — keep that
          directory in git and your categorisation decisions get a history.
        </p>
      </div>

      <div className="flex gap-2 text-xs">
        <Badge>{rows.filter((r) => r.target === 'transaction').length} merchant</Badge>
        <Badge>{rows.filter((r) => r.target === 'line_item').length} line item</Badge>
      </div>

      <Card>
        <RuleTable rows={rows} projects={projects} />
      </Card>
    </div>
  )
}
