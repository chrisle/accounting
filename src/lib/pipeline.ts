import { randomUUID } from 'node:crypto'
import { eq, gte, inArray, sql } from 'drizzle-orm'
import {
  accounts,
  allocations,
  db,
  lineItems,
  transactions,
  txnLineLinks,
  UNALLOCATED,
  type LineItem,
  type Transaction,
} from '@/db'
import { RuleEngine } from '@/lib/attribution/rules'
import { OverrideSet } from '@/lib/attribution/overrides'
import { apportion } from '@/lib/money'
import {
  assertBalanced,
  reconcile,
  withIds,
  type DraftAllocation,
} from '@/lib/reconcile/invariants'
import { adapterFor, ADAPTERS } from '@/lib/sources/registry'
import type { JobLogger, NormalizedTxn } from '@/lib/sources/types'

const noop: JobLogger = () => {}

// -------------------------------------------------------------------- link

/**
 * Rebuild txn <-> line item links for every breakout adapter. Cheap enough to
 * redo wholesale, and doing so means a corrected/re-uploaded export never
 * leaves stale links behind.
 */
export async function runLink(log: JobLogger = noop): Promise<number> {
  const allTxns = await db.select().from(transactions)
  let total = 0

  for (const adapter of ADAPTERS) {
    if (!adapter.link) continue

    const claimed = allTxns.filter((t) => adapter.claims(t))
    if (claimed.length === 0) continue

    const items = await db
      .select()
      .from(lineItems)
      .where(eq(lineItems.source, adapter.id))
    if (items.length === 0) continue

    log(`${adapter.label}: linking ${claimed.length} charges to ${items.length} items`)

    const byExternal = new Map(items.map((li) => [li.externalId, li]))
    const proposals = adapter.link(claimed, items, log)

    await db.delete(txnLineLinks).where(
      inArray(
        txnLineLinks.lineItemId,
        items.map((i) => i.id),
      ),
    )

    const rows = proposals
      .map((p) => {
        const li = byExternal.get(p.lineItemExternalId)
        return li
          ? {
              txnId: p.txnId,
              lineItemId: li.id,
              confidence: p.confidence,
              method: p.method,
            }
          : null
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)

    for (let i = 0; i < rows.length; i += 500) {
      await db.insert(txnLineLinks).values(rows.slice(i, i + 500)).onConflictDoNothing()
    }

    const matched = new Set(rows.map((r) => r.txnId)).size
    log(
      `  linked ${rows.length} items across ${matched}/${claimed.length} charges` +
        ` (${claimed.length - matched} unmatched -> review queue)`,
    )
    total += rows.length
  }
  return total
}

// --------------------------------------------------------------- attribute

/**
 * The main pass. Wipes and rebuilds every allocation from transactions +
 * line items + rules + overrides. Fully derived on purpose: `allocations` is
 * a cache, and being able to throw it away and get a byte-identical result is
 * what makes the whole database disposable.
 *
 * Precedence, highest first:
 *   1. transaction override (a human said so — including % splits)
 *   2. breakout adapter (Amazon items, GCP projects), with per-item overrides
 *   3. passthrough merchant rules
 *   4. residual -> __unallocated__
 */
export async function runAttribute(
  log: JobLogger = noop,
  opts: { since?: string } = {},
): Promise<{ txns: number; allocations: number; unallocatedCents: number }> {
  const [engine, ovr] = await Promise.all([RuleEngine.load(), OverrideSet.load()])
  log(`loaded rules + ${ovr.size} overrides`)

  const where = opts.since ? gte(transactions.date, opts.since) : undefined
  const txns = where
    ? await db.select().from(transactions).where(where)
    : await db.select().from(transactions)

  const links = await db.select().from(txnLineLinks)
  const itemRows = await db.select().from(lineItems)
  const itemsById = new Map(itemRows.map((li) => [li.id, li]))

  const itemsByTxn = new Map<string, LineItem[]>()
  for (const l of links) {
    const li = itemsById.get(l.lineItemId)
    if (!li) continue
    const arr = itemsByTxn.get(l.txnId) ?? []
    arr.push(li)
    itemsByTxn.set(l.txnId, arr)
  }

  const ctx = { classify: engine.classify.bind(engine) }
  const out: ReturnType<typeof withIds> = []
  let unallocatedCents = 0

  for (const txn of txns) {
    const drafts = buildDrafts(txn, itemsByTxn.get(txn.id) ?? [], ovr, ctx)
    const balanced = reconcile(txn.id, txn.amountCents, drafts)
    assertBalanced(txn.id, txn.amountCents, balanced)

    for (const b of balanced) {
      if (b.projectId === UNALLOCATED) unallocatedCents += b.amountCents
    }
    out.push(...withIds(balanced))
  }

  // Swap in one transaction so a mid-rebuild read never sees a half-attributed
  // ledger — the invariant has to hold from the outside at every instant.
  const txnIds = txns.map((t) => t.id)
  db.transaction((tx) => {
    for (let i = 0; i < txnIds.length; i += 500) {
      tx.delete(allocations)
        .where(inArray(allocations.txnId, txnIds.slice(i, i + 500)))
        .run()
    }
    for (let i = 0; i < out.length; i += 500) {
      tx.insert(allocations).values(out.slice(i, i + 500)).run()
    }
  })

  log(`attributed ${txns.length} charges -> ${out.length} allocations`)
  return { txns: txns.length, allocations: out.length, unallocatedCents }
}

function buildDrafts(
  txn: Transaction,
  items: LineItem[],
  ovr: OverrideSet,
  ctx: { classify: RuleEngine['classify'] },
): DraftAllocation[] {
  // 1. A human decision about this charge wins outright.
  const o = ovr.forTxn(txn)
  if (o?.splitPct && Object.keys(o.splitPct).length > 0) {
    const keys = Object.keys(o.splitPct)
    const parts = apportion(txn.amountCents, keys.map((k) => o.splitPct![k]))
    return keys.map((projectId, i) => ({
      txnId: txn.id,
      projectId,
      category: o.category,
      costType: o.costType,
      amountCents: parts[i],
      basis: 'split_rule' as const,
      provenance: 'human' as const,
      confidence: 1,
    }))
  }
  if (o?.projectId) {
    return [
      {
        txnId: txn.id,
        projectId: o.projectId,
        category: o.category,
        costType: o.costType,
        amountCents: txn.amountCents,
        basis: 'manual',
        provenance: 'human',
        confidence: 1,
      },
    ]
  }

  // 2. Break out via the owning adapter, honouring per-item overrides.
  const adapter = adapterFor(txn)
  const drafts = adapter.allocate(txn, items, ctx)
  if (drafts.length > 0) {
    return drafts.map((d) => {
      if (!d.lineItemId) return d
      const li = items.find((x) => x.id === d.lineItemId)
      const lio = li ? ovr.forLineItem(li) : null
      return lio?.projectId
        ? {
            ...d,
            projectId: lio.projectId,
            category: lio.category ?? d.category,
            costType: lio.costType ?? d.costType,
            provenance: 'human' as const,
            confidence: 1,
          }
        : d
    })
  }

  // 3. A breakout adapter claimed it but produced nothing (Amazon charge whose
  //    order data hasn't been uploaded yet). Merchant rules are the fallback.
  return passthroughDrafts(txn, ctx)
}

function passthroughDrafts(
  txn: Transaction,
  ctx: { classify: RuleEngine['classify'] },
): DraftAllocation[] {
  const cls = ctx.classify(txn.merchantNorm, {
    amountCents: txn.amountCents,
    target: 'transaction',
  })
  if (!cls.projectId) return []
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
}

// ------------------------------------------------------------------- store

/**
 * `transactions.account_id` is a foreign key, so every account a batch refers to
 * has to exist before the charges are written. Sources report accounts inline
 * with the transaction rather than as a separate feed, so derive them here —
 * that way any source gets this for free instead of each one remembering.
 *
 * A row that names an account updates it; a row that only carries an id gets a
 * stub so the key resolves, and a later sync with real details fills it in.
 */
async function upsertAccountsFor(rows: NormalizedTxn[]): Promise<void> {
  const named = new Map<string, typeof accounts.$inferInsert>()
  const stubs = new Map<string, typeof accounts.$inferInsert>()

  for (const r of rows) {
    if (!r.accountId) continue
    const a = r.account
    if (a?.name) {
      named.set(r.accountId, {
        id: r.accountId,
        name: a.name,
        institution: a.institution ?? null,
        mask: a.mask ?? null,
        type: a.type ?? null,
      })
    } else if (!named.has(r.accountId)) {
      stubs.set(r.accountId, { id: r.accountId, name: r.accountId })
    }
  }

  for (const [id, row] of named) stubs.delete(id)

  if (stubs.size > 0) {
    // Don't let a stub overwrite a name a previous sync established.
    await db.insert(accounts).values([...stubs.values()]).onConflictDoNothing()
  }
  if (named.size > 0) {
    await db
      .insert(accounts)
      .values([...named.values()])
      .onConflictDoUpdate({
        target: accounts.id,
        set: {
          name: sql`excluded.name`,
          institution: sql`coalesce(excluded.institution, ${accounts.institution})`,
          mask: sql`coalesce(excluded.mask, ${accounts.mask})`,
          type: sql`coalesce(excluded.type, ${accounts.type})`,
        },
      })
  }
}

export async function upsertTransactions(
  rows: NormalizedTxn[],
  sourceDocId: string | null,
): Promise<number> {
  const { createHash } = await import('node:crypto')
  await upsertAccountsFor(rows)
  let n = 0
  for (let i = 0; i < rows.length; i += 200) {
    // `account` is carried for upsertAccountsFor above; it is not a column.
    const chunk = rows.slice(i, i + 200).map(({ account: _account, ...r }) => ({
      ...r,
      accountId: r.accountId ?? null,
      pending: r.pending ?? false,
      sourceDocId,
      contentHash: createHash('sha256')
        .update(`${r.id}|${r.date}|${r.amountCents}|${r.merchantRaw}`)
        .digest('hex')
        .slice(0, 32),
    }))
    await db
      .insert(transactions)
      .values(chunk)
      .onConflictDoUpdate({
        target: transactions.id,
        set: {
          date: sql`excluded.date`,
          amountCents: sql`excluded.amount_cents`,
          merchantRaw: sql`excluded.merchant_raw`,
          merchantNorm: sql`excluded.merchant_norm`,
          copilotCategory: sql`excluded.copilot_category`,
          notes: sql`excluded.notes`,
          pending: sql`excluded.pending`,
          contentHash: sql`excluded.content_hash`,
          updatedAt: sql`(unixepoch())`,
        },
      })
    n += chunk.length
  }
  return n
}

export async function upsertLineItems(
  source: string,
  rows: {
    externalId: string
    date: string
    amountCents: number
    quantity?: number
    description: string
    groupKey?: string | null
    raw?: Record<string, unknown>
  }[],
  sourceDocId: string | null,
): Promise<number> {
  let n = 0
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200).map((r) => ({
      id: randomUUID(),
      source,
      externalId: r.externalId,
      date: r.date,
      amountCents: r.amountCents,
      quantity: r.quantity ?? 1,
      description: r.description,
      groupKey: r.groupKey ?? null,
      raw: r.raw ?? null,
      sourceDocId,
    }))
    await db
      .insert(lineItems)
      .values(chunk)
      .onConflictDoUpdate({
        target: [lineItems.source, lineItems.externalId],
        set: {
          date: sql`excluded.date`,
          amountCents: sql`excluded.amount_cents`,
          description: sql`excluded.description`,
          groupKey: sql`excluded.group_key`,
          raw: sql`excluded.raw`,
        },
      })
    n += chunk.length
  }
  return n
}
