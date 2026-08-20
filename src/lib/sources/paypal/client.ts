import { toCents } from '@/lib/money'
import { API_BASE, getAccessToken } from './auth'
import type { DateRange, JobLogger, NormalizedLineItem } from '../types'

/**
 * Transaction Search (`/v1/reporting/transactions`) is the only PayPal endpoint
 * that reports history rather than a single order, and it comes with two hard
 * limits that shape everything here: a request may span at most **31 days**, and
 * results are paginated with an explicit page number rather than a cursor.
 *
 * Transactions also land in the report roughly three hours after they happen, so
 * a sync run at midnight will not see that evening's spending. The next run
 * picks it up — nothing is lost, it is just not instant.
 */

const MAX_WINDOW_DAYS = 31
const PAGE_SIZE = 500

/**
 * Money moving between the user's own PayPal balance and their own bank or card
 * is not a cost. Counting it would double every purchase — once as the payment
 * and again as the withdrawal that funded it — which is exactly the mistake the
 * Copilot adapter avoids by dropping INTERNAL_TRANSFER.
 *
 * T03xx funds the PayPal account, T04xx withdraws from it.
 */
const TRANSFER_EVENT_CODES = /^T0[34]/

type RawTxn = {
  transaction_info?: {
    transaction_id?: string
    transaction_event_code?: string
    transaction_initiation_date?: string
    transaction_updated_date?: string
    transaction_amount?: { value?: string; currency_code?: string }
    fee_amount?: { value?: string }
    transaction_status?: string
    transaction_subject?: string
    transaction_note?: string
  }
  payer_info?: {
    email_address?: string
    payer_name?: { alternate_full_name?: string; given_name?: string; surname?: string }
  }
  cart_info?: {
    item_details?: { item_name?: string; item_amount?: { value?: string } }[]
  }
}

type Page = {
  transaction_details?: RawTxn[]
  total_pages?: number
  page?: number
}

/** PayPal wants ISO-8601 with an explicit offset; plain dates are rejected. */
const startOf = (d: string) => `${d}T00:00:00-0000`
const endOf = (d: string) => `${d}T23:59:59-0000`

/** Split a range into <=31-day slices, since the API refuses anything wider. */
export function windows(range: DateRange): DateRange[] {
  const out: DateRange[] = []
  const end = new Date(`${range.end}T00:00:00Z`)
  let cursor = new Date(`${range.start}T00:00:00Z`)

  while (cursor <= end) {
    const stop = new Date(cursor)
    stop.setUTCDate(stop.getUTCDate() + MAX_WINDOW_DAYS - 1)
    const sliceEnd = stop > end ? end : stop
    out.push({
      start: cursor.toISOString().slice(0, 10),
      end: sliceEnd.toISOString().slice(0, 10),
    })
    cursor = new Date(sliceEnd)
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

/** Best available human label for a payment, in descending order of use. */
function describe(t: RawTxn): string {
  const info = t.transaction_info ?? {}
  const payer = t.payer_info?.payer_name
  const items = t.cart_info?.item_details ?? []

  const itemNames = items.map((i) => i.item_name?.trim()).filter(Boolean)
  if (itemNames.length) return itemNames.join(', ')

  return (
    info.transaction_subject?.trim() ||
    payer?.alternate_full_name?.trim() ||
    [payer?.given_name, payer?.surname].filter(Boolean).join(' ').trim() ||
    t.payer_info?.email_address?.trim() ||
    info.transaction_note?.trim() ||
    'PayPal payment'
  )
}

export function normalize(t: RawTxn): NormalizedLineItem | null {
  const info = t.transaction_info ?? {}
  const id = info.transaction_id
  const date = (info.transaction_initiation_date ?? info.transaction_updated_date ?? '').slice(0, 10)
  const value = info.transaction_amount?.value
  if (!id || !date || value == null) return null
  if (info.transaction_event_code && TRANSFER_EVENT_CODES.test(info.transaction_event_code)) {
    return null
  }
  // A pending or denied payment has not cost anything yet.
  if (info.transaction_status && !/^[SP]$/.test(info.transaction_status)) return null

  // PayPal already signs money out as negative, which is this ledger's
  // convention too — so the value passes through rather than being flipped the
  // way Copilot's does. The fee is a separate negative field; fold it in, since
  // the card is charged the total.
  const fee = info.fee_amount?.value
  const amountCents = toCents(value) + (fee ? toCents(fee) : 0)

  return {
    externalId: id,
    date,
    amountCents,
    description: describe(t),
    groupKey: t.payer_info?.email_address ?? null,
    raw: {
      eventCode: info.transaction_event_code,
      status: info.transaction_status,
      currency: info.transaction_amount?.currency_code,
      feeValue: fee,
      payerEmail: t.payer_info?.email_address,
    },
  }
}

export async function fetchTransactions(
  range: DateRange,
  log: JobLogger,
): Promise<NormalizedLineItem[]> {
  const token = await getAccessToken()
  const out: NormalizedLineItem[] = []
  let skipped = 0

  for (const w of windows(range)) {
    let page = 1
    for (;;) {
      const url =
        `${API_BASE}/v1/reporting/transactions?` +
        new URLSearchParams({
          start_date: startOf(w.start),
          end_date: endOf(w.end),
          fields: 'transaction_info,payer_info,cart_info',
          page_size: String(PAGE_SIZE),
          page: String(page),
        })

      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } })
      if (!res.ok) {
        const body = await res.text().catch(() => '')
        throw new Error(`PayPal API ${res.status}: ${body.slice(0, 300)}`)
      }
      const data = (await res.json()) as Page

      const rows = data.transaction_details ?? []
      for (const r of rows) {
        const n = normalize(r)
        if (n) out.push(n)
        else skipped++
      }

      const total = data.total_pages ?? 1
      log(`  ${w.start}..${w.end} page ${page}/${total}: ${rows.length} rows (${out.length} kept)`)
      if (page >= total) break
      page++
      if (page > 200) break // runaway guard, same as the Copilot client
    }
  }

  if (skipped > 0) log(`  skipped ${skipped} transfers, pending and unusable rows`)
  return out
}
