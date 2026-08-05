'use server'

import { randomUUID } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { eq } from 'drizzle-orm'
import { db, rules } from '@/db'
import { runAttribute } from '@/lib/pipeline'
import { exportConfig } from '@/lib/config-export'

async function reattributeAndRevalidate() {
  await runAttribute()
  await exportConfig()
  revalidatePath('/rules')
  revalidatePath('/review')
  revalidatePath('/')
}

export async function createRule(formData: FormData) {
  const pattern = String(formData.get('matchPattern') ?? '').trim()
  if (!pattern) throw new Error('A match pattern is required')
  try {
    new RegExp(pattern)
  } catch {
    throw new Error(`"${pattern}" is not a valid regular expression`)
  }

  await db.insert(rules).values({
    id: randomUUID(),
    priority: Number(formData.get('priority') ?? 100),
    target: (String(formData.get('target')) || 'transaction') as 'transaction' | 'line_item',
    scopeSource: String(formData.get('scopeSource') ?? '') || null,
    matchPattern: pattern,
    setProjectId: String(formData.get('setProjectId') ?? '') || null,
    setCategory: String(formData.get('setCategory') ?? '') || null,
    setCostType: String(formData.get('setCostType') ?? '') || null,
  })

  await reattributeAndRevalidate()
}

export async function toggleRule(id: string, enabled: boolean) {
  await db.update(rules).set({ enabled }).where(eq(rules.id, id))
  await reattributeAndRevalidate()
}

export async function deleteRule(id: string) {
  await db.delete(rules).where(eq(rules.id, id))
  await reattributeAndRevalidate()
}
