import { randomUUID } from 'node:crypto'
import { apportion, type Cents } from '@/lib/money'
import { UNALLOCATED } from '@/db/schema'

export type DraftAllocation = {
  txnId: string
  lineItemId?: string | null
  projectId: string
  category?: string | null
  costType?: string | null
  amountCents: Cents
  basis: 'direct' | 'proportional' | 'split_rule' | 'residual' | 'manual'
  provenance: 'rule' | 'line_item' | 'llm' | 'human' | 'fallback'
  confidence?: number
  ruleId?: string | null
  scaleFactor?: number | null
}

export class InvariantViolation extends Error {
  constructor(
    readonly txnId: string,
    readonly expected: Cents,
    readonly actual: Cents,
  ) {
    super(
      `allocations for ${txnId} sum to ${actual}, expected ${expected} (off by ${actual - expected})`,
    )
    this.name = 'InvariantViolation'
  }
}

/**
 * Force `SUM(allocations) === txn.amountCents`, the one rule the whole
 * platform rests on. Three cases, in order:
 *
 *  1. Nothing attributed  -> one residual row on __unallocated__.
 *  2. Sum is off by a lot -> scale proportionally (a metered feed that doesn't
 *     tie to the charge: GCP meters daily usage, the card sees a monthly
 *     invoice net of credits, tax and FX), then book the remainder residual.
 *  3. Sum is off by cents -> largest-remainder apportionment absorbs it.
 *
 * Scaling is recorded on each row as scaleFactor so the drift stays auditable
 * rather than quietly baked in.
 */
export function reconcile(
  txnId: string,
  txnAmountCents: Cents,
  drafts: DraftAllocation[],
  opts: { scaleTolerance?: number } = {},
): DraftAllocation[] {
  const tolerance = opts.scaleTolerance ?? 0.02 // 2% -> scale rather than dump to residual

  if (drafts.length === 0) {
    return [
      {
        txnId,
        projectId: UNALLOCATED,
        amountCents: txnAmountCents,
        basis: 'residual',
        provenance: 'fallback',
        confidence: 0,
      },
    ]
  }

  const sum = drafts.reduce((a, d) => a + d.amountCents, 0)
  if (sum === txnAmountCents) return drafts

  // Same sign and close enough: this is a feed that meters differently from
  // how it bills. Scale it onto the real charge.
  const sameSign = sum !== 0 && Math.sign(sum) === Math.sign(txnAmountCents)
  const drift = sum === 0 ? Infinity : Math.abs((txnAmountCents - sum) / sum)

  if (sameSign && drift <= tolerance) {
    const factor = txnAmountCents / sum
    const parts = apportion(
      txnAmountCents,
      drafts.map((d) => Math.abs(d.amountCents)),
    )
    return drafts.map((d, i) => ({
      ...d,
      amountCents: parts[i],
      basis: 'proportional' as const,
      scaleFactor: factor,
    }))
  }

  // Too far off to be rounding: keep what we know, book the rest honestly.
  const residual = txnAmountCents - sum
  return [
    ...drafts,
    {
      txnId,
      projectId: UNALLOCATED,
      amountCents: residual,
      basis: 'residual',
      provenance: 'fallback',
      confidence: 0,
    },
  ]
}

/** Belt and braces: called before write. Throwing here means a logic bug. */
export function assertBalanced(
  txnId: string,
  txnAmountCents: Cents,
  allocs: { amountCents: Cents }[],
): void {
  const sum = allocs.reduce((a, x) => a + x.amountCents, 0)
  if (sum !== txnAmountCents) {
    throw new InvariantViolation(txnId, txnAmountCents, sum)
  }
}

export function withIds(drafts: DraftAllocation[]) {
  return drafts.map((d) => ({
    id: randomUUID(),
    txnId: d.txnId,
    lineItemId: d.lineItemId ?? null,
    projectId: d.projectId,
    category: d.category ?? null,
    costType: d.costType ?? null,
    amountCents: d.amountCents,
    basis: d.basis,
    provenance: d.provenance,
    confidence: d.confidence ?? 1,
    ruleId: d.ruleId ?? null,
    scaleFactor: d.scaleFactor ?? null,
  }))
}
