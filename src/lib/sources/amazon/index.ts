import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'csv-parse/sync'
import { apportion, toCents } from '@/lib/money'
import { fuzzyLink } from '@/lib/matching/engine'
import { rawDir, ensureDirs } from '@/lib/paths'
import type { DraftAllocation } from '@/lib/reconcile/invariants'
import type { BreakoutAdapter, JobLogger, NormalizedLineItem } from '../types'

const AMAZON_MERCHANTS = /amazon|amzn|amz\b/i

/**
 * Itemized-receipt archetype, and the only source that can't run unattended.
 *
 * Amazon retired the one-click order CSV in March 2023. Item-level data now
 * comes from Privacy Central -> "Request My Data", which is a login, an OTP,
 * and a ~24h wait for an email with a ZIP. That can't be automated from a
 * headless box without doing something both brittle and clearly against
 * Amazon's terms — so the UI takes the upload instead, and nags when the data
 * goes stale.
 *
 * The useful file inside is Retail.OrderHistory.1/Retail.OrderHistory.1.csv.
 */

const CANDIDATE_FILES = [
  /Retail\.OrderHistory\.\d+.*\.csv$/i,
  /Retail\.OrderHistory.*\.csv$/i,
  /orders.*\.csv$/i,
]

type OrderRow = Record<string, string>

const pick = (row: OrderRow, ...names: string[]): string => {
  for (const n of names) {
    const hit = Object.keys(row).find(
      (k) => k.toLowerCase().replace(/[^a-z]/g, '') === n.toLowerCase().replace(/[^a-z]/g, ''),
    )
    if (hit && row[hit]?.trim()) return row[hit].trim()
  }
  return ''
}

/** Parse the Retail.OrderHistory CSV into item-level line items. */
export function parseOrderHistoryCsv(csv: string): NormalizedLineItem[] {
  const rows = parse(csv, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
    bom: true,
  }) as OrderRow[]

  const out: NormalizedLineItem[] = []
  for (const r of rows) {
    const orderId = pick(r, 'Order ID', 'OrderID', 'order_id')
    const date = pick(r, 'Order Date', 'OrderDate', 'Ship Date').slice(0, 10)
    const title = pick(r, 'Product Name', 'Title', 'ProductName')
    const qty = Number(pick(r, 'Quantity', 'Item Quantity') || '1')

    // Amazon's own total for the line, including its share of tax.
    const owed = pick(r, 'Total Owed', 'TotalOwed', 'Item Total', 'Item Net Total')
    const unit = pick(r, 'Unit Price', 'UnitPrice', 'Purchase Price Per Unit')
    if (!orderId || !date) continue

    let cents = 0
    if (owed) cents = toCents(owed)
    else if (unit) cents = toCents(unit) * (Number.isFinite(qty) ? qty : 1)
    if (cents === 0) continue

    const asin = pick(r, 'ASIN', 'ASIN/ISBN') || createHash('sha1').update(title).digest('hex').slice(0, 10)

    out.push({
      externalId: `${orderId}:${asin}:${out.length}`,
      date,
      amountCents: -Math.abs(cents), // purchases are money out
      quantity: Number.isFinite(qty) ? qty : 1,
      description: title || 'Amazon item',
      groupKey: orderId,
      raw: {
        orderId,
        asin,
        seller: pick(r, 'Seller', 'Seller Name'),
        category: pick(r, 'Product Category', 'Category'),
      },
    })
  }
  return out
}

/** Accepts either the full "Request My Data" ZIP or a bare CSV. */
export async function ingestUpload(
  filename: string,
  bytes: Buffer,
  log: JobLogger,
): Promise<{ items: NormalizedLineItem[]; storedPath: string; hash: string }> {
  ensureDirs()
  const hash = createHash('sha256').update(bytes).digest('hex')
  const dir = path.join(rawDir(), 'amazon')
  await mkdir(dir, { recursive: true })
  const storedPath = path.join(dir, `${hash.slice(0, 12)}-${path.basename(filename)}`)
  await writeFile(storedPath, bytes)
  log(`  stored ${filename} (${(bytes.length / 1024).toFixed(0)} KB)`)

  let csv: string | null = null

  if (filename.toLowerCase().endsWith('.zip')) {
    const { unzipSync, strFromU8 } = await import('fflate')
    // `filter` means only the order-history CSV is actually decompressed —
    // the full "Request My Data" archive is mostly files we don't want.
    const found = unzipSync(new Uint8Array(bytes), {
      filter: (f) => CANDIDATE_FILES.some((re) => re.test(f.name)),
    })
    const name = Object.keys(found)[0]
    if (name) {
      log(`  found ${name}`)
      csv = strFromU8(found[name])
    }
    if (!csv) {
      throw new Error(
        'No Retail.OrderHistory CSV found in that ZIP. Request the "Your Orders" ' +
          'dataset from Amazon Privacy Central and upload the archive it emails you.',
      )
    }
  } else {
    csv = bytes.toString('utf8')
  }

  const items = parseOrderHistoryCsv(csv)
  log(`  parsed ${items.length} item rows`)
  return { items, storedPath, hash }
}

export const amazonAdapter: BreakoutAdapter = {
  id: 'amazon',
  label: 'Amazon',
  archetype: 'itemized',
  connect: 'upload',

  claims: (txn) =>
    AMAZON_MERCHANTS.test(txn.merchantRaw) || AMAZON_MERCHANTS.test(txn.merchantNorm),

  // Amazon charges per shipment, not per order, and merges orders into single
  // captures — so this is a bounded subset-sum, not a join. See matching/engine.
  link: (txns, items) =>
    fuzzyLink(txns, items, {
      daysBefore: 7,
      daysAfter: 3,
      toleranceCents: 200,
      tolerancePct: 0.09, // tax + shipping aren't in the per-item total
    }),

  allocate(txn, items, ctx) {
    if (items.length === 0) return []

    // Item amounts don't include the charge's tax/shipping, so apportion the
    // real charge across items by weight rather than trusting their sum.
    const parts = apportion(
      txn.amountCents,
      items.map((li) => Math.abs(li.amountCents)),
    )

    return items.map((li, i): DraftAllocation => {
      const cls = ctx.classify(li.description, {
        source: 'amazon',
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
        confidence: cls.projectId ? 0.9 : 0,
        ruleId: cls.ruleId,
      }
    })
  },
}
