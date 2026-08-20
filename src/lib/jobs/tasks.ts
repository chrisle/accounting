import { randomUUID } from 'node:crypto'
import { eq, sql } from 'drizzle-orm'
import { db, sourceDocuments, sourceState, type Job } from '@/db'
import { runAttribute, runLink, upsertLineItems, upsertTransactions } from '@/lib/pipeline'
import { copilotAdapter, gcpAdapter } from '@/lib/sources/registry'
import { exportConfig } from '@/lib/config-export'
import { logWarn } from '@/lib/logs'
import type { JobLogger } from '@/lib/sources/types'

/** Default sync window. Long enough to catch late-posting and amended rows. */
function defaultRange(days = 120) {
  const end = new Date()
  const start = new Date(end.getTime() - days * 86_400_000)
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

async function markSource(
  source: string,
  status: 'ok' | 'error',
  error?: string,
): Promise<void> {
  // Surface per-source failures on the logs page. Inside sync:all these are
  // caught so one source can't stop the others, so the job itself succeeds and
  // this warning is the only global signal that a connector is down.
  if (status === 'error') logWarn(`sync:${source}`, error ?? 'sync failed')
  await db
    .insert(sourceState)
    .values({
      source,
      connected: true,
      lastSyncAt: Math.floor(Date.now() / 1000),
      lastSyncStatus: status,
      lastError: error ?? null,
    })
    .onConflictDoUpdate({
      target: sourceState.source,
      set: {
        lastSyncAt: sql`excluded.last_sync_at`,
        lastSyncStatus: sql`excluded.last_sync_status`,
        lastError: sql`excluded.last_error`,
      },
    })
}

async function recordDoc(
  source: string,
  kind: 'snapshot' | 'upload' | 'query',
  rowCount: number,
  extra: Partial<typeof sourceDocuments.$inferInsert> = {},
): Promise<string> {
  const id = randomUUID()
  await db
    .insert(sourceDocuments)
    .values({
      id,
      source,
      kind,
      contentHash: extra.contentHash ?? randomUUID(),
      rowCount,
      ...extra,
    })
    .onConflictDoNothing()
  return id
}

export async function runJob(job: Job, log: JobLogger): Promise<void> {
  const payload = (job.payload ?? {}) as Record<string, any>

  switch (job.kind) {
    case 'sync:copilot': {
      const range = payload.range ?? defaultRange()
      log(`Copilot: fetching ${range.start} .. ${range.end}`)
      try {
        const txns = await copilotAdapter.fetchTransactions!(range, log)
        const docId = await recordDoc('copilot', 'snapshot', txns.length, {
          periodStart: range.start,
          periodEnd: range.end,
        })
        const n = await upsertTransactions(txns, docId)
        log(`Copilot: ${n} transactions upserted`)
        await markSource('copilot', 'ok')
      } catch (e) {
        await markSource('copilot', 'error', String(e))
        throw e
      }
      break
    }

    case 'sync:gcp': {
      const range = payload.range ?? defaultRange(120)
      log(`GCP: querying billing export ${range.start} .. ${range.end}`)
      try {
        const items = await gcpAdapter.fetch!(range, log)
        const docId = await recordDoc('gcp', 'query', items.length, {
          periodStart: range.start,
          periodEnd: range.end,
        })
        const n = await upsertLineItems('gcp', items, docId)
        log(`GCP: ${n} usage rows upserted`)
        await markSource('gcp', 'ok')
      } catch (e) {
        await markSource('gcp', 'error', String(e))
        throw e
      }
      break
    }

    case 'ingest:amazon': {
      // The upload route has already parsed and stored the archive; this job
      // just folds the parsed rows into the ledger.
      const { items, storedPath, hash, filename } = payload as {
        items: any[]
        storedPath: string
        hash: string
        filename: string
      }
      log(`Amazon: ingesting ${items.length} item rows from ${filename}`)
      const docId = await recordDoc('amazon', 'upload', items.length, {
        filename,
        storedPath,
        contentHash: hash,
      })
      const n = await upsertLineItems('amazon', items, docId)
      log(`Amazon: ${n} line items upserted`)
      await markSource('amazon', 'ok')
      break
    }

    case 'link': {
      const n = await runLink(log)
      log(`linked ${n} item↔charge pairs`)
      break
    }

    case 'attribute': {
      const r = await runAttribute(log, payload.since ? { since: payload.since } : {})
      const pct =
        r.spendCents > 0
          ? ((r.unallocatedSpendCents / r.spendCents) * 100).toFixed(1)
          : '0.0'
      log(
        `unallocated: ${(r.unallocatedSpendCents / 100).toFixed(2)} of ` +
          `${(r.spendCents / 100).toFixed(2)} spend (${pct}% needs triage)`,
      )
      await exportConfig(log)
      break
    }

    case 'sync:all': {
      // Sources are independent: one failing must not stop the others, and
      // attribution should still run on whatever did land.
      for (const kind of ['sync:copilot', 'sync:gcp'] as const) {
        try {
          await runJob({ ...job, kind, payload: {} }, log)
        } catch (e) {
          log(`! ${kind} failed: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      await runJob({ ...job, kind: 'link', payload: {} }, log)
      await runJob({ ...job, kind: 'attribute', payload: {} }, log)
      break
    }

    default:
      throw new Error(`unknown job kind: ${job.kind}`)
  }
}
