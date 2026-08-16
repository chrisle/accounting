import { appendLog, claimNext, enqueue, finish, reapStale } from './queue'
import { runJob } from './tasks'
import { runMigrations } from '@/db/migrate'
import { logInfo, logError, logWarn, trimLogs } from '@/lib/logs'

/**
 * Next has no worker process, and that's fine — `output: 'standalone'` is a
 * long-lived Node server, so a poll loop started from instrumentation.ts is a
 * perfectly good scheduler for one user. No Redis, no sidecar container.
 *
 * Everything here is deliberately single-flight: one job at a time, one
 * process. SQLite is happiest that way and there is nothing to contend over.
 */

let started = false
const POLL_MS = 2_000

async function drain(): Promise<void> {
  for (;;) {
    const job = await claimNext()
    if (!job) return

    const log = (line: string) => {
      console.log(`[job ${job.kind}] ${line}`)
      void appendLog(job.id, line)
    }

    try {
      log(`started`)
      logInfo(job.kind, 'started')
      await runJob(job, log)
      await finish(job.id, 'ok')
      log(`done`)
      logInfo(job.kind, 'done')
    } catch (e) {
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e)
      log(`FAILED: ${msg}`)
      logError(job.kind, e instanceof Error ? e.message : String(e), e)
      await finish(job.id, 'error', e instanceof Error ? e.message : String(e))
    } finally {
      trimLogs()
    }
  }
}

/** "04:15" -> ms until the next occurrence in local time. */
function msUntil(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  const now = new Date()
  const next = new Date(now)
  next.setHours(h, m, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  return next.getTime() - now.getTime()
}

function scheduleNightly(): void {
  const at = process.env.COSTS_SYNC_AT ?? '04:15'
  if (at === 'off') {
    logInfo('scheduler', 'nightly sync disabled')
    return
  }
  const wait = msUntil(at)
  logInfo(
    'scheduler',
    `nightly sync at ${at} (in ${(wait / 3_600_000).toFixed(1)}h)`,
  )
  setTimeout(() => {
    logInfo('scheduler', 'nightly sync firing')
    void enqueue('sync:all')
    scheduleNightly()
  }, wait).unref?.()
}

export function startWorker(): void {
  if (started) return
  started = true

  runMigrations()
  void reapStale().then((n) => {
    if (n > 0) logWarn('worker', `reaped ${n} stale job(s) left running by a restart`)
  })

  const tick = () => {
    drain()
      .catch((e) => {
        console.error('[worker] drain error', e)
        logError('worker', 'drain error', e)
      })
      .finally(() => setTimeout(tick, POLL_MS).unref?.())
  }
  tick()

  scheduleNightly()
  logInfo('worker', 'started')
}
