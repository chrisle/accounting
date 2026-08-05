import { apportion } from '@/lib/money'
import { periodLink } from '@/lib/matching/engine'
import type { DraftAllocation } from '@/lib/reconcile/invariants'
import { getSecret } from '@/lib/secrets'
import type {
  BreakoutAdapter,
  DateRange,
  JobLogger,
  NormalizedLineItem,
} from '../types'

const GCP_MERCHANTS = /google\s*(cloud|gcp)|gcp|google\s*svcs|google\s*payment/i

/**
 * Metered-usage archetype.
 *
 * The BigQuery billing export meters *usage by day, by project, by SKU*. Your
 * card sees a *monthly invoice net of committed-use discounts, promotional
 * credits, tax and FX*. These two numbers will never be equal, and chasing
 * equality is a waste of time — so this adapter emits usage-shaped line items
 * and lets reconcile() scale them onto the real charge, recording the factor.
 */
async function fetchUsage(
  range: DateRange,
  log: JobLogger,
): Promise<NormalizedLineItem[]> {
  const raw = await getSecret('gcp.service_account_json')
  const table = await getSecret('gcp.billing_table')
  if (!raw || !table) {
    throw new Error('GCP is not connected. Add a service account and billing table in Sources.')
  }

  const credentials = JSON.parse(raw) as { project_id: string }
  const { BigQuery } = await import('@google-cloud/bigquery')
  const bq = new BigQuery({ credentials, projectId: credentials.project_id })

  // Net of credits, which is what actually shows up on the invoice.
  const sql = `
    SELECT
      DATE(usage_start_time)                       AS day,
      project.id                                   AS project_id,
      COALESCE(project.name, project.id)           AS project_name,
      service.description                          AS service,
      sku.description                              AS sku,
      SUM(cost) +
        SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) c), 0)) AS net_cost
    FROM \`${table}\`
    WHERE DATE(usage_start_time) BETWEEN @start AND @end
    GROUP BY day, project_id, project_name, service, sku
    HAVING ABS(net_cost) > 0.000001
    ORDER BY day`

  log(`  querying ${table} for ${range.start}..${range.end}`)
  const [rows] = await bq.query({
    query: sql,
    params: { start: range.start, end: range.end },
  })
  log(`  ${rows.length} usage rows`)

  return rows.map((r: any) => {
    const day = typeof r.day === 'string' ? r.day : r.day.value
    const projectId = r.project_id ?? 'unknown'
    return {
      externalId: `${projectId}:${r.service}:${r.sku}:${day}`,
      date: day,
      // Costs are money out -> negative, matching the ledger convention.
      amountCents: -Math.round(Number(r.net_cost) * 100),
      description: `${r.service} · ${r.sku}`,
      groupKey: projectId,
      raw: {
        gcpProject: projectId,
        gcpProjectName: r.project_name,
        service: r.service,
        sku: r.sku,
      },
    }
  })
}

export const gcpAdapter: BreakoutAdapter = {
  id: 'gcp',
  label: 'Google Cloud',
  archetype: 'metered',
  connect: 'credentials',

  claims: (txn) => GCP_MERCHANTS.test(txn.merchantRaw) || GCP_MERCHANTS.test(txn.merchantNorm),

  fetch: fetchUsage,
  link: (txns, items) => periodLink(txns, items),

  allocate(txn, items, ctx) {
    if (items.length === 0) return []

    // Roll SKU-day rows up to one allocation per GCP project. Per-SKU detail
    // stays queryable via line_items; the dashboard wants project granularity.
    const byProject = new Map<string, { items: typeof items; weight: number }>()
    for (const li of items) {
      const key = li.groupKey ?? 'unknown'
      const g = byProject.get(key) ?? { items: [], weight: 0 }
      g.items.push(li)
      g.weight += Math.abs(li.amountCents)
      byProject.set(key, g)
    }

    const keys = [...byProject.keys()]
    const parts = apportion(
      txn.amountCents,
      keys.map((k) => byProject.get(k)!.weight),
    )

    return keys.map((gcpProject, i): DraftAllocation => {
      const cls = ctx.classify(gcpProject, {
        source: 'gcp',
        target: 'line_item',
        amountCents: parts[i],
      })
      return {
        txnId: txn.id,
        lineItemId: byProject.get(gcpProject)!.items[0].id,
        projectId: cls.projectId ?? '__unallocated__',
        category: cls.category ?? 'Utilities',
        costType: cls.costType ?? 'Cloud Infrastructure',
        amountCents: parts[i],
        basis: 'proportional',
        provenance: cls.projectId ? 'rule' : 'fallback',
        confidence: cls.projectId ? 0.95 : 0,
        ruleId: cls.ruleId,
      }
    })
  },
}
