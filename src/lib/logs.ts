import { randomUUID } from 'node:crypto'
import { desc, eq, sql } from 'drizzle-orm'
import { db, logs, type LogEntry } from '@/db'

export type LogLevel = 'info' | 'warn' | 'error'

/** How many rows to keep. The table is a rolling window, not an archive. */
const KEEP = 2000

/**
 * Record a runtime event. Logging must never break the thing it's observing,
 * so every failure here is swallowed — a broken logger silently degrades to
 * console output rather than taking down a sync. Mirrors to the console too, so
 * `docker logs` still shows everything.
 */
export function logEvent(
  level: LogLevel,
  source: string,
  message: string,
  detail?: unknown,
): void {
  const line = `[${source}] ${message}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  try {
    db.insert(logs)
      .values({
        id: randomUUID(),
        level,
        source,
        message: message.slice(0, 2000),
        detail: detail == null ? null : stringify(detail).slice(0, 8000),
      })
      .run()
  } catch {
    // A logging failure is not worth surfacing anywhere it could cascade.
  }
}

export const logInfo = (source: string, msg: string, detail?: unknown) =>
  logEvent('info', source, msg, detail)
export const logWarn = (source: string, msg: string, detail?: unknown) =>
  logEvent('warn', source, msg, detail)
export const logError = (source: string, msg: string, detail?: unknown) =>
  logEvent('error', source, msg, detail)

function stringify(d: unknown): string {
  if (d instanceof Error) return d.stack ?? d.message
  if (typeof d === 'string') return d
  try {
    return JSON.stringify(d)
  } catch {
    return String(d)
  }
}

/**
 * Keep only the newest KEEP rows. Trimmed by rowid, not ts: `unixepoch()` is
 * second-resolution, so a burst of logs shares a timestamp and a ts cutoff
 * can't separate them. rowid is monotonic and safe here specifically because
 * trim only ever deletes the *oldest* rows — the max rowid is never removed, so
 * SQLite never reuses it. Best-effort.
 */
export function trimLogs(keep = KEEP): void {
  try {
    db.run(
      sql`DELETE FROM logs WHERE rowid NOT IN (SELECT rowid FROM logs ORDER BY rowid DESC LIMIT ${keep})`,
    )
  } catch {
    // best-effort
  }
}

export async function recentLogs(
  limit = 500,
  level?: LogLevel,
): Promise<LogEntry[]> {
  // Order by rowid, not ts: same-second bursts must still come back in
  // insertion order (newest first), which ts can't guarantee.
  const order = [desc(logs.ts), sql`rowid desc`]
  const q = db.select().from(logs)
  const rows = level
    ? await q.where(eq(logs.level, level)).orderBy(...order).limit(limit)
    : await q.orderBy(...order).limit(limit)
  return rows
}

export async function clearLogs(): Promise<void> {
  await db.delete(logs)
}

/** Counts per level, for the filter tabs. */
export async function logCounts(): Promise<Record<LogLevel | 'all', number>> {
  const rows = await db
    .select({ level: logs.level, n: sql<number>`count(*)` })
    .from(logs)
    .groupBy(logs.level)
  const out = { all: 0, info: 0, warn: 0, error: 0 }
  for (const r of rows) {
    out[r.level as LogLevel] = Number(r.n)
    out.all += Number(r.n)
  }
  return out
}
