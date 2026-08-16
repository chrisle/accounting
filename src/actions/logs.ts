'use server'

import { revalidatePath } from 'next/cache'
import { clearLogs } from '@/lib/logs'

export async function clearLogsAction() {
  await clearLogs()
  revalidatePath('/logs')
}
