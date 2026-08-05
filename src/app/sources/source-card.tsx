'use client'

import { useRef, useState, useTransition } from 'react'
import { Badge, Card } from '@/components/ui'
import { connectCopilot, connectGcp, disconnectSource, syncNow } from '@/actions/sources'
import type { JobKind } from '@/lib/jobs/queue'

type State = {
  connected: boolean
  lastSyncAt: number | null
  lastSyncStatus: string
  lastError: string | null
} | null

const ARCHETYPE_HINT: Record<string, string> = {
  passthrough: 'One charge → one allocation',
  itemized: 'One charge → many items',
  metered: 'One invoice → many project × SKU rows',
}

const ago = (ts: number | null) => {
  if (!ts) return 'never'
  const s = Date.now() / 1000 - ts
  if (s < 3600) return `${Math.round(s / 60)}m ago`
  if (s < 86400) return `${Math.round(s / 3600)}h ago`
  return `${Math.round(s / 86400)}d ago`
}

export function SourceCard({
  adapter,
  state,
  rowCount,
  latestData,
  lastDocAt,
}: {
  adapter: { id: string; label: string; archetype: string; connect: string }
  state: State
  rowCount: number
  latestData: string | null
  lastDocAt: number | null
}) {
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const connected = state?.connected ?? false

  // Amazon data goes stale silently — surface it rather than quietly charting
  // a picture that's three months out of date.
  const staleDays = lastDocAt ? (Date.now() / 1000 - lastDocAt) / 86400 : null
  const stale = adapter.connect === 'upload' && staleDays !== null && staleDays > 45

  const doSync = () =>
    start(async () => {
      setError(null)
      try {
        await syncNow(`sync:${adapter.id}` as JobKind)
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })

  const upload = (file: File) =>
    start(async () => {
      setError(null)
      const fd = new FormData()
      fd.append('file', file)
      const res = await fetch('/api/uploads/amazon', { method: 'POST', body: fd })
      if (!res.ok) setError((await res.json().catch(() => ({}))).error ?? 'Upload failed')
    })

  return (
    <Card
      title={adapter.label}
      subtitle={ARCHETYPE_HINT[adapter.archetype]}
      action={
        connected ? (
          state?.lastSyncStatus === 'error' ? (
            <Badge tone="crit">error</Badge>
          ) : stale ? (
            <Badge tone="warn">stale</Badge>
          ) : (
            <Badge tone="good">connected</Badge>
          )
        ) : (
          <Badge>not connected</Badge>
        )
      }
    >
      <dl className="mb-4 grid grid-cols-2 gap-y-1.5 text-xs">
        <dt className="text-ink-3">Last sync</dt>
        <dd className="tnum text-right text-ink-2">{ago(state?.lastSyncAt ?? null)}</dd>
        <dt className="text-ink-3">Rows held</dt>
        <dd className="tnum text-right text-ink-2">{rowCount.toLocaleString()}</dd>
        {latestData && (
          <>
            <dt className="text-ink-3">Data through</dt>
            <dd className="tnum text-right text-ink-2">{latestData}</dd>
          </>
        )}
      </dl>

      {stale && (
        <p className="mb-3 rounded border border-warn/40 px-2.5 py-2 text-xs text-warn">
          Last export was {Math.round(staleDays!)} days ago. Request a fresh one
          from Amazon Privacy Central — it takes ~24h to arrive.
        </p>
      )}

      {state?.lastError && (
        <p className="mb-3 max-h-24 overflow-y-auto rounded border border-crit/40 px-2.5 py-2 text-xs text-crit">
          {state.lastError}
        </p>
      )}
      {error && (
        <p className="mb-3 rounded border border-crit/40 px-2.5 py-2 text-xs text-crit">
          {error}
        </p>
      )}

      <div className="flex flex-wrap gap-2">
        {adapter.connect === 'upload' ? (
          <>
            <input
              ref={fileRef}
              type="file"
              accept=".zip,.csv"
              className="hidden"
              onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
            />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={pending}
              className="rounded border border-line px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-40"
            >
              {pending ? 'Uploading…' : 'Upload export'}
            </button>
          </>
        ) : (
          <>
            <button
              onClick={doSync}
              disabled={pending || !connected}
              className="rounded border border-line px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2 disabled:opacity-40"
            >
              {pending ? 'Queued…' : 'Sync now'}
            </button>
            <button
              onClick={() => setOpen((o) => !o)}
              className="rounded border border-line px-3 py-1.5 text-xs font-medium text-ink-2 hover:bg-surface-2"
            >
              {connected ? 'Reconnect' : 'Connect'}
            </button>
            {connected && (
              <button
                onClick={() => start(() => disconnectSource(adapter.id))}
                className="rounded px-2 py-1.5 text-xs text-ink-3 hover:text-crit"
              >
                Disconnect
              </button>
            )}
          </>
        )}
      </div>

      {open && adapter.id === 'copilot' && (
        <form action={connectCopilot} className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
          <p className="text-xs text-ink-3">
            Paste the Firebase refresh token from a logged-in Copilot web session
            (DevTools → Application → Local Storage). It&apos;s long-lived, so this
            is a one-time step.
          </p>
          <input
            name="refreshToken"
            required
            placeholder="Firebase refresh token"
            className="rounded border border-line bg-surface-2 px-2 py-1.5 text-xs"
          />
          <input
            name="apiKey"
            placeholder="Firebase API key (optional)"
            className="rounded border border-line bg-surface-2 px-2 py-1.5 text-xs"
          />
          <button className="self-start rounded border border-line px-3 py-1.5 text-xs font-medium hover:bg-surface-2">
            Save &amp; sync
          </button>
        </form>
      )}

      {open && adapter.id === 'gcp' && (
        <form action={connectGcp} className="mt-4 flex flex-col gap-2 border-t border-line pt-4">
          <p className="text-xs text-ink-3">
            A service account with <code>bigquery.jobUser</code> and read access to
            the detailed billing export.
          </p>
          <input
            name="billingTable"
            required
            placeholder="project.dataset.gcp_billing_export_resource_v1_XXXXXX"
            className="rounded border border-line bg-surface-2 px-2 py-1.5 text-xs"
          />
          <textarea
            name="serviceAccount"
            required
            rows={4}
            placeholder='{"type":"service_account", ...}'
            className="rounded border border-line bg-surface-2 px-2 py-1.5 font-mono text-[11px]"
          />
          <button className="self-start rounded border border-line px-3 py-1.5 text-xs font-medium hover:bg-surface-2">
            Save &amp; sync
          </button>
        </form>
      )}
    </Card>
  )
}
