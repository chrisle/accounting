import { createHash } from 'node:crypto'
import { db, overrides } from '@/db'
import type { LineItem, Transaction } from '@/db/schema'

/**
 * Human corrections are keyed by a *stable fingerprint*, never a row id.
 *
 * Copilot renumbers things; a re-requested Amazon export produces fresh ids.
 * If overrides keyed on ids, every re-sync would silently discard your work.
 * Fingerprinting on the semantic identity of the charge means a correction you
 * made in March still applies to the same recurring charge in November.
 */
export function txnFingerprint(t: {
  merchantNorm: string
  amountCents: number
}): string {
  return (
    'txn:' +
    createHash('sha256')
      .update(`${t.merchantNorm}|${t.amountCents}`)
      .digest('hex')
      .slice(0, 20)
  )
}

/** Recurring subscriptions: same merchant, any amount. Broader on purpose. */
export function merchantFingerprint(merchantNorm: string): string {
  return (
    'merchant:' +
    createHash('sha256').update(merchantNorm).digest('hex').slice(0, 20)
  )
}

export function lineItemFingerprint(li: {
  source: string
  description: string
  groupKey?: string | null
}): string {
  // GCP: the project is the identity. Amazon: the product title is.
  const identity = li.source === 'gcp' ? (li.groupKey ?? li.description) : li.description
  return (
    'li:' +
    createHash('sha256')
      .update(`${li.source}|${identity.toLowerCase().trim()}`)
      .digest('hex')
      .slice(0, 20)
  )
}

export type OverrideRow = typeof overrides.$inferSelect

export class OverrideSet {
  constructor(private readonly map: Map<string, OverrideRow>) {}

  static async load(): Promise<OverrideSet> {
    const rows = await db.select().from(overrides)
    return new OverrideSet(new Map(rows.map((r) => [r.fingerprint, r])))
  }

  /** Exact charge first, then any-amount merchant rule. */
  forTxn(t: Transaction): OverrideRow | null {
    return (
      this.map.get(txnFingerprint(t)) ??
      this.map.get(merchantFingerprint(t.merchantNorm)) ??
      null
    )
  }

  forLineItem(li: LineItem): OverrideRow | null {
    return this.map.get(lineItemFingerprint(li)) ?? null
  }

  get size() {
    return this.map.size
  }
}
