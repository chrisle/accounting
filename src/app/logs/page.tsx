import { Card } from '@/components/ui'
import { recentLogs } from '@/lib/logs'
import { LogList } from './log-list'

export const dynamic = 'force-dynamic'

export default async function LogsPage() {
  const initial = await recentLogs(500)

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-lg font-semibold">System logs</h1>
        <p className="mt-1 max-w-2xl text-sm text-ink-3">
          Runtime events across the app — worker lifecycle, the nightly
          scheduler, sync failures and invariant warnings. The newest 2,000 are
          kept; per-job output lives on the Sources page.
        </p>
      </div>

      <Card>
        <LogList initial={initial} />
      </Card>
    </div>
  )
}
