/**
 * Next calls register() exactly once when the server boots. This is the whole
 * orchestration layer: migrations, then the job worker and nightly scheduler,
 * in-process. No sidecar, no cron container, no queue broker.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return
  const { startWorker } = await import('@/lib/jobs/worker')
  startWorker()
}
