import { and, desc, eq, gte, lte, sql } from 'drizzle-orm'
import {
  allocations,
  db,
  lineItems,
  projects,
  transactions,
  UNALLOCATED,
} from '@/db'

/**
 * Everything the dashboard draws reads from `allocations`, never from
 * `transactions` directly. That's what makes the numbers trustworthy: the
 * reconciler guarantees allocations sum to the real charge, so a project total
 * and the bank statement can never silently disagree.
 *
 * Costs are stored negative (money out). These queries flip the sign so the
 * UI works in positive "spend" throughout.
 */

export type MonthlyPoint = { month: string } & Record<string, number | string>

export async function spendByMonth(months = 12): Promise<{
  data: MonthlyPoint[]
  projectIds: string[]
}> {
  const since = monthsAgo(months)
  const rows = await db
    .select({
      month: sql<string>`substr(${transactions.date}, 1, 7)`,
      projectId: allocations.projectId,
      cents: sql<number>`sum(${allocations.amountCents})`,
    })
    .from(allocations)
    .innerJoin(transactions, eq(allocations.txnId, transactions.id))
    .where(and(gte(transactions.date, since), lte(allocations.amountCents, 0)))
    .groupBy(sql`1`, allocations.projectId)

  const byMonth = new Map<string, Record<string, number>>()
  const seen = new Set<string>()
  for (const r of rows) {
    seen.add(r.projectId)
    const m = byMonth.get(r.month) ?? {}
    m[r.projectId] = (m[r.projectId] ?? 0) + Math.abs(r.cents) / 100
    byMonth.set(r.month, m)
  }

  const data = monthRange(months).map((month) => ({
    month,
    ...Object.fromEntries([...seen].map((p) => [p, byMonth.get(month)?.[p] ?? 0])),
  })) as MonthlyPoint[]

  return { data, projectIds: [...seen] }
}

export async function spendByProject(months = 12) {
  const since = monthsAgo(months)
  return db
    .select({
      projectId: allocations.projectId,
      name: projects.name,
      color: projects.color,
      synthetic: projects.synthetic,
      cents: sql<number>`abs(sum(${allocations.amountCents}))`,
      txnCount: sql<number>`count(distinct ${allocations.txnId})`,
    })
    .from(allocations)
    .innerJoin(transactions, eq(allocations.txnId, transactions.id))
    .innerJoin(projects, eq(allocations.projectId, projects.id))
    .where(and(gte(transactions.date, since), lte(allocations.amountCents, 0)))
    .groupBy(allocations.projectId)
    .orderBy(desc(sql`abs(sum(${allocations.amountCents}))`))
}

/** Headline numbers: real spend, what we don't understand, and the trend. */
export async function summary(months = 12) {
  const since = monthsAgo(months)
  const [row] = await db
    .select({
      totalCents: sql<number>`abs(coalesce(sum(${allocations.amountCents}), 0))`,
      unallocatedCents: sql<number>`abs(coalesce(sum(case when ${allocations.projectId} = ${UNALLOCATED} then ${allocations.amountCents} else 0 end), 0))`,
      txnCount: sql<number>`count(distinct ${allocations.txnId})`,
      allocCount: sql<number>`count(*)`,
    })
    .from(allocations)
    .innerJoin(transactions, eq(allocations.txnId, transactions.id))
    .where(and(gte(transactions.date, since), lte(allocations.amountCents, 0)))

  const thisMonth = new Date().toISOString().slice(0, 7)
  const [cur] = await db
    .select({ cents: sql<number>`abs(coalesce(sum(${allocations.amountCents}), 0))` })
    .from(allocations)
    .innerJoin(transactions, eq(allocations.txnId, transactions.id))
    .where(
      and(
        sql`substr(${transactions.date}, 1, 7) = ${thisMonth}`,
        lte(allocations.amountCents, 0),
      ),
    )

  const coverage =
    row.totalCents > 0 ? 1 - row.unallocatedCents / row.totalCents : 1

  return { ...row, thisMonthCents: cur?.cents ?? 0, coverage }
}

/** One project drilled down to its merchants. */
export async function projectBreakdown(projectId: string, months = 12) {
  const since = monthsAgo(months)
  return db
    .select({
      merchant: transactions.merchantRaw,
      cents: sql<number>`abs(sum(${allocations.amountCents}))`,
      count: sql<number>`count(*)`,
      costType: allocations.costType,
    })
    .from(allocations)
    .innerJoin(transactions, eq(allocations.txnId, transactions.id))
    .where(
      and(
        eq(allocations.projectId, projectId),
        gte(transactions.date, since),
        lte(allocations.amountCents, 0),
      ),
    )
    .groupBy(transactions.merchantRaw)
    .orderBy(desc(sql`abs(sum(${allocations.amountCents}))`))
    .limit(50)
}

export async function projectLineItems(projectId: string, limit = 100) {
  return db
    .select({
      id: allocations.id,
      date: transactions.date,
      merchant: transactions.merchantRaw,
      description: lineItems.description,
      cents: allocations.amountCents,
      basis: allocations.basis,
      provenance: allocations.provenance,
      confidence: allocations.confidence,
    })
    .from(allocations)
    .innerJoin(transactions, eq(allocations.txnId, transactions.id))
    .leftJoin(lineItems, eq(allocations.lineItemId, lineItems.id))
    .where(eq(allocations.projectId, projectId))
    .orderBy(desc(transactions.date))
    .limit(limit)
}

/** The review queue: everything the system guessed at or gave up on. */
export async function reviewQueue(limit = 200) {
  return db
    .select({
      allocationId: allocations.id,
      txnId: allocations.txnId,
      lineItemId: allocations.lineItemId,
      date: transactions.date,
      merchant: transactions.merchantRaw,
      merchantNorm: transactions.merchantNorm,
      description: lineItems.description,
      source: lineItems.source,
      groupKey: lineItems.groupKey,
      cents: allocations.amountCents,
      txnCents: transactions.amountCents,
      projectId: allocations.projectId,
      confidence: allocations.confidence,
      provenance: allocations.provenance,
    })
    .from(allocations)
    .innerJoin(transactions, eq(allocations.txnId, transactions.id))
    .leftJoin(lineItems, eq(allocations.lineItemId, lineItems.id))
    .where(
      and(
        sql`(${allocations.projectId} = ${UNALLOCATED} or ${allocations.confidence} < 0.8)`,
        lte(allocations.amountCents, 0),
      ),
    )
    .orderBy(sql`abs(${allocations.amountCents}) desc`)
    .limit(limit)
}

export async function listProjects() {
  return db.select().from(projects).orderBy(projects.sortOrder, projects.name)
}

/** Proof the invariant holds. Any row here is a bug. */
export async function invariantBreaches() {
  return db
    .select({
      txnId: transactions.id,
      date: transactions.date,
      merchant: transactions.merchantRaw,
      txnCents: transactions.amountCents,
      allocCents: sql<number>`coalesce(sum(${allocations.amountCents}), 0)`,
    })
    .from(transactions)
    .leftJoin(allocations, eq(allocations.txnId, transactions.id))
    .groupBy(transactions.id)
    .having(sql`coalesce(sum(${allocations.amountCents}), 0) != ${transactions.amountCents}`)
    .limit(50)
}

// ------------------------------------------------------------------ helpers

function monthsAgo(n: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  d.setDate(1)
  return d.toISOString().slice(0, 10)
}

function monthRange(n: number): string[] {
  const out: string[] = []
  const d = new Date()
  d.setDate(1)
  for (let i = n - 1; i >= 0; i--) {
    const x = new Date(d)
    x.setMonth(d.getMonth() - i)
    out.push(x.toISOString().slice(0, 7))
  }
  return out
}
