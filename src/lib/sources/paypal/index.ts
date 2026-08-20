import { apportion } from '@/lib/money'
import { fuzzyLink } from '@/lib/matching/engine'
import type { DraftAllocation } from '@/lib/reconcile/invariants'
import type { BreakoutAdapter } from '../types'
import { fetchTransactions } from './client'
import { isConnected } from './auth'

/**
 * A PayPal charge reaches the card as "PAYPAL *SOMETHING" — sometimes the
 * merchant, often just a payment id. What was actually bought is only visible
 * inside PayPal, which makes this an itemized-receipt source: one card charge,
 * one (occasionally several) PayPal payments underneath it.
 */
const PAYPAL_MERCHANTS = /paypal|\bpp\*|payflow/i

export const paypalAdapter: BreakoutAdapter = {
  id: 'paypal',
  label: 'PayPal',
  archetype: 'itemized',
  connect: 'credentials',

  claims: (txn) =>
    PAYPAL_MERCHANTS.test(txn.merchantRaw) || PAYPAL_MERCHANTS.test(txn.merchantNorm),

  fetch: fetchTransactions,

  // PayPal debits the funding source the same day or the next, so the default
  // five-day settlement window is wider than it needs to be — and a narrower
  // one keeps two same-priced payments in one week from swapping places. The
  // amounts should tie to the cent: no tax or shipping is added on the way to
  // the card.
  link: (txns, items) =>
    fuzzyLink(txns, items, {
      daysBefore: 2,
      daysAfter: 2,
      toleranceCents: 0,
      tolerancePct: 0,
    }),

  allocate(txn, items, ctx) {
    if (items.length === 0) return []

    const parts = apportion(
      txn.amountCents,
      items.map((li) => Math.abs(li.amountCents)),
    )

    return items.map((li, i): DraftAllocation => {
      const cls = ctx.classify(li.description, {
        source: 'paypal',
        target: 'line_item',
        amountCents: parts[i],
      })
      return {
        txnId: txn.id,
        lineItemId: li.id,
        projectId: cls.projectId ?? '__unallocated__',
        category: cls.category,
        costType: cls.costType,
        amountCents: parts[i],
        basis: 'proportional',
        provenance: cls.projectId ? 'rule' : 'fallback',
        // The description is the counterparty or the item name, which is a
        // stronger signal than an Amazon line but weaker than a GCP project id.
        confidence: cls.projectId ? 0.9 : 0,
        ruleId: cls.ruleId,
      }
    })
  },
}

export { isConnected }
