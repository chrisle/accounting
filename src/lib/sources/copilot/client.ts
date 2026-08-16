import { getIdToken } from './auth'
import { toCents } from '@/lib/money'
import { normalizeMerchant } from '@/lib/attribution/rules'
import type { DateRange, JobLogger, NormalizedTxn } from '../types'

const ENDPOINT =
  process.env.COPILOT_GRAPHQL_URL ?? 'https://app.copilot.money/api/graphql'

/**
 * Verified against the live API on 2026-08-15. `Query.transactions` is a
 * Relay-style connection, and the fields are flat — `accountId`/`categoryId`
 * rather than nested `account`/`category` objects. The shape here matches the
 * `TransactionFields` fragment in Copilot's own web bundle.
 *
 * Note that server-side introspection is disabled (Apollo returns
 * INTROSPECTION_DISABLED), so `introspect()` below cannot work in production.
 * The way to re-derive this is to send a deliberately wrong field and read
 * Apollo's "Did you mean" validation errors — see ops/copilot-token.sh.
 */
const TRANSACTIONS_QUERY = `
query Transactions($first: Int, $after: String, $filter: TransactionFilter) {
  transactions(first: $first, after: $after, filter: $filter) {
    pageInfo {
      hasNextPage
      endCursor
    }
    edges {
      cursor
      node {
        id
        date
        amount
        name
        accountId
        categoryId
        isPending
        userNotes
        type
        parentId
      }
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

/**
 * Kept for the Sources page, but the server refuses it in production. Prefer
 * probing with a wrong field name and reading the validation error.
 */
export async function introspect(): Promise<string> {
  const data = await graphql<{ __schema: { types: unknown[] } }>(`
    { __schema { queryType { name }
        types { name kind fields { name type { name kind ofType { name } } } } } }
  `)
  return JSON.stringify(data, null, 2)
}

type RawTxn = {
  id: string
  date: string
  amount: number | string
  name?: string | null
  accountId?: string | null
  categoryId?: string | null
  isPending?: boolean | null
  userNotes?: string | null
  type?: string | null
  parentId?: string | null
}

/**
 * Money between one account of yours and another isn't a cost. Including it
 * would inflate every total and leave transfers sitting in the review queue
 * forever, since no rule can meaningfully attribute them to a project.
 */
const SKIPPED_TYPES = new Set(['INTERNAL_TRANSFER'])

function normalizeTxn(r: RawTxn): NormalizedTxn | null {
  const id = r.id
  const date = r.date?.toString().slice(0, 10)
  if (!id || !date || r.amount == null) return null
  if (r.type && SKIPPED_TYPES.has(r.type)) return null

  const merchantRaw = r.name?.trim() || 'unknown'

  // Copilot's sign convention is the opposite of this ledger's: it reports
  // spend as positive and income as negative. Flipping here is what keeps
  // "money out is negative" true everywhere downstream — get this wrong and
  // the dashboard, which filters on amount_cents <= 0, silently shows nothing.
  const amountCents = -toCents(
    typeof r.amount === 'number' ? r.amount : String(r.amount),
  )

  const accountId = r.accountId ?? null

  return {
    id: String(id),
    date,
    amountCents,
    merchantRaw,
    merchantNorm: normalizeMerchant(merchantRaw),
    accountId,
    // Only the id is exposed on the transaction; the account's name and mask
    // live behind a separate query, so this creates a stub row that a later
    // sync can fill in. transactions.account_id is a foreign key.
    account: accountId ? { id: accountId } : null,
    copilotCategory: r.categoryId ?? null,
    notes: r.userNotes ?? null,
    pending: Boolean(r.isPending),
  }
}

export async function fetchTransactions(
  range: DateRange,
  log: JobLogger,
): Promise<NormalizedTxn[]> {
  type Page = {
    transactions: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null }
      edges: { cursor: string; node: RawTxn }[]
    }
  }

  const out: NormalizedTxn[] = []
  let after: string | null = null
  let page = 0
  let skipped = 0

  for (;;) {
    const data: Page = await graphql<Page>(TRANSACTIONS_QUERY, {
      first: 500,
      after,
      filter: { dates: { from: range.start, to: range.end } },
    })

    const edges = data.transactions?.edges ?? []
    for (const edge of edges) {
      const n = normalizeTxn(edge.node)
      if (n) out.push(n)
      else skipped++
    }

    const info = data.transactions?.pageInfo
    log(`  page ${++page}: ${edges.length} rows (${out.length} kept)`)

    if (!info?.hasNextPage || !info.endCursor) break
    after = info.endCursor
    if (page > 200) break // runaway guard
  }

  if (skipped > 0) log(`  skipped ${skipped} transfers and unusable rows`)
  return out
}
