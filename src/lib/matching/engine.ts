import type { LineItem, Transaction } from '@/db/schema'
import type { LinkProposal } from '@/lib/sources/types'

export type MatchOptions = {
  /** Settlement lag: an auth on the 3rd can post on the 6th. */
  daysBefore?: number
  daysAfter?: number
  /** Absolute cents of slack, plus a relative allowance for tax/shipping. */
  toleranceCents?: number
  tolerancePct?: number
}

const DEFAULTS: Required<MatchOptions> = {
  daysBefore: 5,
  daysAfter: 3,
  toleranceCents: 100,
  tolerancePct: 0.06,
}

const DAY = 86_400_000
const parse = (d: string) => Date.parse(`${d}T00:00:00Z`)

/**
 * Match one charge to the subset of line items that produced it.
 *
 * This is the hard part of the whole system. Amazon does not charge you per
 * order — it charges per *shipment*, merges unrelated orders into one capture,
 * applies gift-card balance silently, and settles days after the order date.
 * So this is a subset-sum over a date window, not a join.
 *
 * Exhaustive subset-sum is exponential, so we bound it: candidates are sorted
 * by |amount| descending and explored depth-first with pruning, capped at
 * `maxCandidates`. Anything that doesn't resolve cleanly is deliberately left
 * unlinked — it surfaces in the review queue rather than being guessed at.
 */
export function matchBySubsetSum(
  txn: Transaction,
  candidates: LineItem[],
  opts: MatchOptions = {},
): { items: LineItem[]; confidence: number } | null {
  const o = { ...DEFAULTS, ...opts }
  const target = Math.abs(txn.amountCents)
  const txnMs = parse(txn.date)

  const inWindow = candidates
    .filter((li) => {
      const d = (txnMs - parse(li.date)) / DAY
      return d >= -o.daysAfter && d <= o.daysBefore
    })
    .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents))

  if (inWindow.length === 0) return null

  const slack = Math.max(o.toleranceCents, Math.round(target * o.tolerancePct))

  // Exact single item first — by far the common case, and unambiguous.
  const single = inWindow.find(
    (li) => Math.abs(Math.abs(li.amountCents) - target) === 0,
  )
  if (single) return { items: [single], confidence: 1 }

  const pool = inWindow.slice(0, 18) // 2^18 worst case, pruned hard in practice
  let best: { items: LineItem[]; diff: number } | null = null

  const walk = (i: number, picked: LineItem[], sum: number) => {
    const diff = Math.abs(sum - target)
    if (picked.length > 0 && diff <= slack) {
      if (!best || diff < best.diff || (diff === best.diff && picked.length < best.items.length)) {
        best = { items: [...picked], diff }
      }
      if (diff === 0) return true // perfect, stop
    }
    if (i >= pool.length || sum > target + slack) return false
    // Remaining items can't close the gap -> prune.
    const remaining = pool.slice(i).reduce((a, x) => a + Math.abs(x.amountCents), 0)
    if (sum + remaining < target - slack) return false

    if (walk(i + 1, [...picked, pool[i]], sum + Math.abs(pool[i].amountCents))) return true
    return walk(i + 1, picked, sum)
  }
  walk(0, [], 0)

  if (!best) return null
  const b = best as { items: LineItem[]; diff: number }
  // Confidence falls off with how much slack we had to use.
  const confidence = Math.max(0.5, 1 - b.diff / Math.max(slack, 1) / 2)
  return { items: b.items, confidence: Number(confidence.toFixed(3)) }
}

/** Shared default `link` implementation for itemized-receipt adapters. */
export function fuzzyLink(
  txns: Transaction[],
  items: LineItem[],
  opts: MatchOptions = {},
): LinkProposal[] {
  const proposals: LinkProposal[] = []
  const consumed = new Set<string>()

  // Largest charges first: they're the most constrained, so matching them
  // early stops a big charge from being starved by small greedy matches.
  const ordered = [...txns].sort(
    (a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents),
  )

  for (const txn of ordered) {
    const available = items.filter((li) => !consumed.has(li.id))
    const hit = matchBySubsetSum(txn, available, opts)
    if (!hit) continue
    for (const li of hit.items) {
      consumed.add(li.id)
      proposals.push({
        txnId: txn.id,
        lineItemExternalId: li.externalId,
        confidence: hit.confidence,
        method: hit.confidence === 1 && hit.items.length === 1 ? 'exact' : 'amount_date_fuzzy',
      })
    }
  }
  return proposals
}

/** Metered feeds link by billing period, not by amount. */
export function periodLink(
  txns: Transaction[],
  items: LineItem[],
): LinkProposal[] {
  const byMonth = new Map<string, LineItem[]>()
  for (const li of items) {
    const m = li.date.slice(0, 7)
    if (!byMonth.has(m)) byMonth.set(m, [])
    byMonth.get(m)!.push(li)
  }

  const out: LinkProposal[] = []
  for (const txn of txns) {
    // A charge posted in month M almost always bills usage from M-1.
    const d = new Date(`${txn.date}T00:00:00Z`)
    d.setUTCMonth(d.getUTCMonth() - 1)
    const prev = d.toISOString().slice(0, 7)
    for (const li of byMonth.get(prev) ?? []) {
      out.push({
        txnId: txn.id,
        lineItemExternalId: li.externalId,
        confidence: 0.9,
        method: 'invoice_period',
      })
    }
  }
  return out
}
