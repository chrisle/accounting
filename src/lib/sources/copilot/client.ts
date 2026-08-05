import { getIdToken } from './auth'
import { toCents } from '@/lib/money'
import { normalizeMerchant } from '@/lib/attribution/rules'
import type { DateRange, JobLogger, NormalizedTxn } from '../types'

const ENDPOINT =
  process.env.COPILOT_GRAPHQL_URL ?? 'https://app.copilot.money/api/graphql'

/**
 * ------------------------------------------------------------------------
 * UNVERIFIED: the exact query shape below is inferred, not confirmed.
 *
 * Copilot publishes no schema and the endpoint needs a live account to
 * introspect, which I can't do from here. The field names follow the
 * conventions the community clients use, but expect to adjust them on first
 * connect. `normalizeTxn` is deliberately tolerant of several shapes so a
 * naming mismatch degrades to "no rows" rather than a crash, and
 * `introspect()` is wired up so you can dump the real schema in one click
 * from the Sources page and correct this.
 * ------------------------------------------------------------------------
 */
const TRANSACTIONS_QUERY = `
query Transactions($start: String!, $end: String!, $limit: Int!, $cursor: String) {
  transactions(startDate: $start, endDate: $end, limit: $limit, cursor: $cursor) {
    cursor
    items {
      id
      date
      amount
      name
      merchant { name }
      account { id name mask }
      category { id name }
      notes
      pending
      excluded
    }
  }
}`

export async function graphql<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const token = await getIdToken()
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  })

  if (!res.ok) {
    throw new Error(
      `Copilot API ${res.status}: ${(await res.text().catch(() => '')).slice(0, 300)}`,
    )
  }
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (json.errors?.length) {
    throw new Error(`Copilot API: ${json.errors.map((e) => e.message).join('; ')}`)
  }
  if (!json.data) throw new Error('Copilot API returned no data')
  return json.data
}

/** Dump the live schema so the query above can be corrected against reality. */
export async function introspect(): Promise<string> {
  const data = await graphql<{ __schema: { types: unknown[] } }>(`
    { __schema { queryType { name }
        types { name kind fields { name type { name kind ofType { name } } } } } }
  `)
  return JSON.stringify(data, null, 2)
}

type RawTxn = Record<string, any>

/** Tolerant of several plausible field spellings — see the note above. */
function normalizeTxn(r: RawTxn): NormalizedTxn | null {
  const id = r.id ?? r.transactionId ?? r._id
  const date: string | undefined = (r.date ?? r.postedDate ?? r.transactionDate)
    ?.toString()
    .slice(0, 10)
  const rawAmount =
    r.amount ?? (r.amountCents != null ? r.amountCents / 100 : undefined) ?? r.value
  if (!id || !date || rawAmount == null) return null

  const merchantRaw: string =
    r.merchant?.name ?? r.merchantName ?? r.name ?? r.description ?? 'unknown'

  // Copilot reports spend as a positive number in some surfaces. Money out is
  // negative here, always — the sign convention has to be unambiguous or the
  // reconciliation invariant becomes meaningless.
  const cents = typeof rawAmount === 'number' ? toCents(rawAmount) : toCents(String(rawAmount))

  return {
    id: String(id),
    date,
    amountCents: cents,
    merchantRaw,
    merchantNorm: normalizeMerchant(merchantRaw),
    accountId: r.account?.id ?? r.accountId ?? null,
    copilotCategory: r.category?.name ?? r.categoryName ?? null,
    notes: r.notes ?? null,
    pending: Boolean(r.pending),
  }
}

export async function fetchTransactions(
  range: DateRange,
  log: JobLogger,
): Promise<NormalizedTxn[]> {
  type Page = { transactions: { cursor: string | null; items: RawTxn[] } }

  const out: NormalizedTxn[] = []
  let cursor: string | null = null
  let page = 0

  do {
    const data: Page = await graphql<Page>(TRANSACTIONS_QUERY, {
      start: range.start,
      end: range.end,
      limit: 500,
      cursor,
    })

    const items = data.transactions?.items ?? []
    for (const raw of items) {
      if (raw.excluded) continue // hidden in Copilot -> hidden here
      const n = normalizeTxn(raw)
      if (n) out.push(n)
    }

    cursor = data.transactions?.cursor ?? null
    log(`  page ${++page}: ${items.length} rows (${out.length} total)`)
    if (page > 200) break // runaway guard
  } while (cursor)

  return out
}
