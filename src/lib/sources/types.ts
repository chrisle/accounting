import type { Cents } from '@/lib/money'
import type { DraftAllocation } from '@/lib/reconcile/invariants'
import type { LineItem, Transaction } from '@/db/schema'

export type JobLogger = (msg: string) => void

export type DateRange = { start: string; end: string } // ISO yyyy-mm-dd

export type NormalizedTxn = {
  id: string
  date: string
  amountCents: Cents
  merchantRaw: string
  merchantNorm: string
  accountId?: string | null
  copilotCategory?: string | null
  notes?: string | null
  pending?: boolean
}

export type NormalizedLineItem = {
  externalId: string
  date: string
  amountCents: Cents
  quantity?: number
  description: string
  groupKey?: string | null
  raw?: Record<string, unknown>
}

export type LinkProposal = {
  txnId: string
  lineItemExternalId: string
  confidence: number
  method: 'exact' | 'amount_date_fuzzy' | 'invoice_period' | 'manual'
}

/**
 * Every cost source implements this. Three archetypes cover everything so far:
 *
 *   passthrough        one charge -> one allocation      (Figma, Spotify)
 *   itemized receipt   one charge -> N items             (Amazon, Apple)
 *   metered usage      one invoice -> N project x SKU    (GCP, AWS, Anthropic)
 *
 * Adding Cloudflare later is one folder and zero changes to the core.
 */
export interface BreakoutAdapter {
  readonly id: string
  readonly label: string
  readonly archetype: 'passthrough' | 'itemized' | 'metered'
  /** How the user connects it — drives the Sources page UI. */
  readonly connect: 'oauth' | 'credentials' | 'upload' | 'none'

  /** Does this adapter claim responsibility for breaking out this charge? */
  claims(txn: Transaction): boolean

  /** Pull (or read already-uploaded) line items for a window. */
  fetch?(range: DateRange, log: JobLogger): Promise<NormalizedLineItem[]>

  /** Pull transactions themselves. Only the ledger source (Copilot) does this. */
  fetchTransactions?(range: DateRange, log: JobLogger): Promise<NormalizedTxn[]>

  /** Propose txn <-> line item links. Defaults to the shared fuzzy matcher. */
  link?(txns: Transaction[], items: LineItem[], log: JobLogger): LinkProposal[]

  /**
   * Turn one charge plus its linked items into draft allocations. Amounts need
   * not tie exactly — reconcile() scales or books a residual afterwards.
   */
  allocate(
    txn: Transaction,
    items: LineItem[],
    ctx: AllocationContext,
  ): DraftAllocation[]
}

export type AllocationContext = {
  /** Resolve a description/merchant to a project via the rules engine. */
  classify: (
    text: string,
    opts?: { source?: string; amountCents?: Cents; target?: 'transaction' | 'line_item' },
  ) => {
    projectId: string | null
    category: string | null
    costType: string | null
    ruleId: string | null
  }
}
