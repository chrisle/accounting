'use server'

import { revalidatePath } from 'next/cache'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, lineItems, overrides, rules, transactions } from '@/db'
import {
  lineItemFingerprint,
  merchantFingerprint,
  txnFingerprint,
} from '@/lib/attribution/overrides'
import { enqueue } from '@/lib/jobs/queue'
import { runAttribute } from '@/lib/pipeline'
import { exportConfig } from '@/lib/config-export'

/**
 * The review queue exists to convert one-off corrections into durable rules.
 * Every assignment writes a sticky override; `alsoCreateRule` additionally
 * writes a pattern so the *next* charge like this never reaches the queue.
 * That's the loop that makes the system more accurate every week without you
 * touching any code.
 */
export async function assignProject(input: {
  txnId: string
  lineItemId?: string | null
  projectId: string
  category?: string
  costType?: string
  scope: 'this_charge' | 'this_merchant' | 'this_item'
  alsoCreateRule?: boolean
}) {
  const [txn] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, input.txnId))
    .limit(1)
  if (!txn) throw new Error('transaction not found')

  let fingerprint: string
  let scope: 'transaction' | 'line_item' = 'transaction'
  let rulePattern: string | null = null
  let ruleTarget: 'transaction' | 'line_item' = 'transaction'
  let ruleSource: string | null = null

  if (input.scope === 'this_item' && input.lineItemId) {
    const [li] = await db
      .select()
      .from(lineItems)
      .where(eq(lineItems.id, input.lineItemId))
      .limit(1)
    if (!li) throw new Error('line item not found')
    fingerprint = lineItemFingerprint(li)
    scope = 'line_item'
    ruleTarget = 'line_item'
    ruleSource = li.source
    rulePattern = escapeRe(li.source === 'gcp' ? (li.groupKey ?? li.description) : li.description)
  } else if (input.scope === 'this_merchant') {
    fingerprint = merchantFingerprint(txn.merchantNorm)
    rulePattern = escapeRe(txn.merchantNorm)
  } else {
    fingerprint = txnFingerprint(txn)
  }

  await db
    .insert(overrides)
    .values({
      fingerprint,
      scope,
      projectId: input.projectId,
      category: input.category ?? null,
      costType: input.costType ?? null,
    })
    .onConflictDoUpdate({
      target: overrides.fingerprint,
      set: {
        projectId: input.projectId,
        category: input.category ?? null,
        costType: input.costType ?? null,
        splitPct: null,
      },
    })

  if (input.alsoCreateRule && rulePattern) {
    await db.insert(rules).values({
      id: randomUUID(),
      priority: 50,
      target: ruleTarget,
      scopeSource: ruleSource,
      matchPattern: rulePattern,
      setProjectId: input.projectId,
      setCategory: input.category ?? null,
      setCostType: input.costType ?? null,
      note: 'created from review queue',
    })
  }

  await runAttribute()
  await exportConfig()
  revalidatePath('/review')
  revalidatePath('/')
}

/** Shared infrastructure: one charge serving several projects. */
export async function splitCharge(input: {
  txnId: string
  splitPct: Record<string, number>
  applyToMerchant?: boolean
}) {
  const [txn] = await db
    .select()
    .from(transactions)
    .where(eq(transactions.id, input.txnId))
    .limit(1)
  if (!txn) throw new Error('transaction not found')

  const total = Object.values(input.splitPct).reduce((a, b) => a + b, 0)
  if (total <= 0) throw new Error('split percentages must sum to more than zero')

  const fingerprint = input.applyToMerchant
    ? merchantFingerprint(txn.merchantNorm)
    : txnFingerprint(txn)

  await db
    .insert(overrides)
    .values({ fingerprint, scope: 'transaction', splitPct: input.splitPct })
    .onConflictDoUpdate({
      target: overrides.fingerprint,
      set: { splitPct: input.splitPct, projectId: null },
    })

  await runAttribute()
  await exportConfig()
  revalidatePath('/review')
  revalidatePath('/')
}

export async function reattribute() {
  await enqueue('attribute')
  revalidatePath('/review')
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
