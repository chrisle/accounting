import Link from 'next/link'
import { Card } from '@/components/ui'
import { formatCents } from '@/lib/money'
import { listProjects, spendByProject } from '@/lib/queries'

export const dynamic = 'force-dynamic'

export default async function ProjectsPage() {
  const [projects, spend] = await Promise.all([listProjects(), spendByProject(14)])
  const byId = new Map(spend.map((s) => [s.projectId, s]))

  return (
    <div className="flex flex-col gap-5">
      <h1 className="text-lg font-semibold">Projects</h1>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {projects.map((p) => {
          const s = byId.get(p.id)
          return (
            <Link key={p.id} href={`/projects/${p.id}`}>
              <Card className="h-full transition-colors hover:border-line-strong">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden
                    className="size-3 rounded-[3px]"
                    style={{ background: p.color }}
                  />
                  <h2 className="text-sm font-semibold text-ink">{p.name}</h2>
                </div>
                <div className="tnum mt-3 text-2xl font-semibold text-ink">
                  {formatCents(s?.cents ?? 0)}
                </div>
                <div className="mt-1 text-xs text-ink-3">
                  {s?.txnCount ?? 0} charges · last 14 months
                </div>
              </Card>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
