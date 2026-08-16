import { randomUUID } from 'node:crypto'
import { and, desc, eq, sql } from 'drizzle-orm'
import { db, jobs, type Job } from '@/db'

export type JobKind =
  | 'sync:copilot'
  | 'sync:gcp'
  | 'ingest:amazon'
  | 'link'
  | 'attribute'
  | 'sync:all'

export async function enqueue(
  kind: JobKind,
  payload: Record<string, unknown> = {},
): Promise<string> {
  // One queued job per kind is enough — clicking "Sync now" five times should
  // not run five syncs.
  const [existing] = await db
    .select()
    .from(jobs)
    .where(and(eq(jobs.kind, kind), eq(jobs.status, 'queued')))
    .limit(1)
  if (existing) return existing.id

  const id = randomUUID()
  await db.insert(jobs).values({ id, kind, payload, status: 'queued' })
  return id
}

export async function claimNext(): Promise<Job | null> {
  // Single-process worker, so a plain read-then-mark is safe here.
  const [next] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.status, 'queued'))
    .orderBy(jobs.queuedAt)
    .limit(1)
  if (!next) return null

  await db
    .update(jobs)
    .set({ status: 'running', startedAt: Math.floor(Date.now() / 1000), log: '' })
    .where(eq(jobs.id, next.id))
  return { ...next, status: 'running' }
}

export async function appendLog(id: string, line: string): Promise<void> {
  await db
    .update(jobs)
    .set({ log: sql`${jobs.log} || ${line + '\n'}` })
    .where(eq(jobs.id, id))
}

export async function finish(
  id: string,
  status: 'ok' | 'error',
  error?: string,
): Promise<void> {
  await db
    .update(jobs)
    .set({ status, error: error ?? null, finishedAt: Math.floor(Date.now() / 1000) })
    .where(eq(jobs.id, id))
}

export async function recentJobs(limit = 25): Promise<Job[]> {
  return db.select().from(jobs).orderBy(desc(jobs.queuedAt)).limit(limit)
}

export async function getJob(id: string): Promise<Job | null> {
  const [j] = await db.select().from(jobs).where(eq(jobs.id, id)).limit(1)
  return j ?? null
}

/** A crash mid-job leaves a zombie 'running' row; reap it at boot. */
export async function reapStale(): Promise<number> {
  const stale = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.status, 'running'))
  if (stale.length === 0) return 0
  await db
    .update(jobs)
    .set({ status: 'error', error: 'interrupted by restart', finishedAt: Math.floor(Date.now() / 1000) })
    .where(eq(jobs.status, 'running'))
  return stale.length
}
