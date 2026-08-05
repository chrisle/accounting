import type { BreakoutAdapter } from './types'
import type { DraftAllocation } from '@/lib/reconcile/invariants'

/**
 * The floor. Every charge no breakout adapter claimed — a $12 SaaS sub, a
 * domain renewal — becomes exactly one allocation, project resolved from the
 * merchant rules. Claims nothing itself; the pipeline falls back to it.
 */
export const passthroughAdapter: BreakoutAdapter = {
  id: 'passthrough',
  label: 'Direct',
  archetype: 'passthrough',
  connect: 'none',
  claims: () => false,

  allocate(txn, _items, ctx): DraftAllocation[] {
    const cls = ctx.classify(txn.merchantNorm, {
      amountCents: txn.amountCents,
      target: 'transaction',
    })
    if (!cls.projectId) return [] // -> reconcile books it to __unallocated__

    return [
      {
        txnId: txn.id,
        projectId: cls.projectId,
        category: cls.category,
        costType: cls.costType,
        amountCents: txn.amountCents,
        basis: 'direct',
        provenance: 'rule',
        confidence: 1,
        ruleId: cls.ruleId,
      },
    ]
  },
}
