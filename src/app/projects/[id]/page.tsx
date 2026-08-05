import Link from 'next/link'
import { notFound } from 'next/navigation'
import { eq } from 'drizzle-orm'
import { db, projects } from '@/db'
import { Badge, Card, Stat } from '@/components/ui'
import { formatCents } from '@/lib/money'
import { projectBreakdown, projectLineItems, spendByProject } from '@/lib/queries'

export const dynamic = 'force-dynamic'

export default async function ProjectPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const [project] = await db.select().from(projects).where(eq(projects.id, id)).limit(1)
  if (!project) notFound()

  const [merchants, items, totals] = await Promise.all([
    projectBreakdown(id, 14),
    projectLineItems(id, 150),
    spendByProject(14),
  ])
  const total = totals.find((t) => t.projectId === id)

  return (
    <div className="flex flex-col gap-5">
      <div>
        <Link href="/projects" className="text-xs text-ink-3 hover:underline">
          ← Projects
        </Link>
        <h1 className="mt-1 flex items-center gap-2.5 text-lg font-semibold">
          <span
            aria-hidden
            className="size-3.5 rounded-[3px]"
            style={{ background: project.color }}
          />
          {project.name}
        </h1>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Stat label="Spend, 14 months" value={formatCents(total?.cents ?? 0)} />
        <Stat label="Charges" value={String(total?.txnCount ?? 0)} />
        <Stat label="Merchants" value={String(merchants.length)} />
      </div>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        <Card title="By merchant" subtitle="Last 14 months">
          <table className="w-full text-sm">
            <tbody>
              {merchants.map((m) => (
                <tr key={m.merchant} className="border-b border-line/60 last:border-0">
                  <td className="max-w-[220px] truncate py-2 text-ink">{m.merchant}</td>
                  <td className="py-2 text-xs text-ink-3">{m.costType ?? '—'}</td>
                  <td className="tnum py-2 text-right font-medium">
                    {formatCents(m.cents)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card
          title="Line items"
          subtitle="Item-level detail where a breakout source provided it"
        >
          <div className="max-h-[520px] overflow-y-auto">
            <table className="w-full text-sm">
              <tbody>
                {items.map((it) => (
                  <tr key={it.id} className="border-b border-line/60 last:border-0">
                    <td className="whitespace-nowrap py-2 pr-3 text-xs text-ink-3">
                      {it.date}
                    </td>
                    <td className="py-2">
                      <div className="max-w-[280px] truncate text-ink">
                        {it.description ?? it.merchant}
                      </div>
                      {it.description && (
                        <div className="truncate text-xs text-ink-3">{it.merchant}</div>
                      )}
                    </td>
                    <td className="py-2 pl-2">
                      {it.provenance === 'human' ? (
                        <Badge tone="good">manual</Badge>
                      ) : it.provenance === 'fallback' ? (
                        <Badge tone="warn">unmatched</Badge>
                      ) : (
                        <Badge>{it.basis}</Badge>
                      )}
                    </td>
                    <td className="tnum py-2 text-right font-medium">
                      {formatCents(Math.abs(it.cents))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  )
}
