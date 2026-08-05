'use server'

import { revalidatePath } from 'next/cache'
import { sql } from 'drizzle-orm'
import { db, sourceState } from '@/db'
import { enqueue, type JobKind } from '@/lib/jobs/queue'
import { putSecret } from '@/lib/secrets'
import { saveRefreshToken, disconnect as disconnectCopilot } from '@/lib/sources/copilot/auth'

export async function syncNow(kind: JobKind) {
  const id = await enqueue(kind)
  revalidatePath('/sources')
  return id
}

export async function connectCopilot(formData: FormData) {
  const token = String(formData.get('refreshToken') ?? '').trim()
  const apiKey = String(formData.get('apiKey') ?? '').trim()
  if (!token) throw new Error('A Firebase refresh token is required')

  await saveRefreshToken(token, apiKey || undefined)
  await db
    .insert(sourceState)
    .values({ source: 'copilot', connected: true })
    .onConflictDoUpdate({
      target: sourceState.source,
      set: { connected: true, lastError: null },
    })

  await enqueue('sync:copilot')
  revalidatePath('/sources')
}

export async function disconnectSource(source: string) {
  if (source === 'copilot') await disconnectCopilot()
  await db
    .update(sourceState)
    .set({ connected: false, cursor: null })
    .where(sql`${sourceState.source} = ${source}`)
  revalidatePath('/sources')
}

export async function connectGcp(formData: FormData) {
  const json = String(formData.get('serviceAccount') ?? '').trim()
  const table = String(formData.get('billingTable') ?? '').trim()
  if (!json || !table) {
    throw new Error('Both a service account JSON and a billing table are required')
  }
  try {
    JSON.parse(json)
  } catch {
    throw new Error('That service account is not valid JSON')
  }

  await putSecret('gcp.service_account_json', json)
  await putSecret('gcp.billing_table', table)
  await db
    .insert(sourceState)
    .values({ source: 'gcp', connected: true, config: { billingTable: table } })
    .onConflictDoUpdate({
      target: sourceState.source,
      set: { connected: true, lastError: null, config: { billingTable: table } },
    })

  await enqueue('sync:gcp')
  revalidatePath('/sources')
}
