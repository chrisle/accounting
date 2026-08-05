import { randomUUID } from 'node:crypto'
import { db, projects, rules, transactions, lineItems, accounts } from './index'
import { runMigrations } from './migrate'
import { normalizeMerchant } from '@/lib/attribution/rules'
import { runAttribute, runLink, upsertLineItems, upsertTransactions } from '@/lib/pipeline'
import { exportConfig } from '@/lib/config-export'
import { UNALLOCATED } from './schema'

/**
 * Realistic demo data so the dashboard has something to draw before you
 * connect anything: 14 months of recurring SaaS, an Amazon order history that
 * splits across shipments, and GCP usage across four cloud projects.
 */

/**
 * Categorical slots in fixed order from the validated palette — assigned to an
 * entity, never to its rank, so filtering the dashboard never repaints the
 * survivors. Both modes validated as a set (worst adjacent CVD ΔE 9.1 light /
 * 8.4 dark). Unallocated is deliberately NOT a categorical hue: it's a missing
 * -data state, so it wears neutral gray.
 */
const PROJECTS = [
  { id: 'now-playing', name: 'Now Playing', color: '#2a78d6', colorDark: '#3987e5', sortOrder: 1 },
  { id: 'triode-brand', name: 'TRIODE Brand', color: '#eb6834', colorDark: '#d95926', sortOrder: 2 },
  { id: 'twitch-channel', name: 'Twitch Channel', color: '#1baf7a', colorDark: '#199e70', sortOrder: 3 },
  { id: 'dj-operations', name: 'DJ Operations', color: '#eda100', colorDark: '#c98500', sortOrder: 4 },
  { id: 'music-production', name: 'Music Production', color: '#e87ba4', colorDark: '#d55181', sortOrder: 5 },
  { id: 'infrastructure', name: 'Infrastructure', color: '#008300', colorDark: '#008300', sortOrder: 6 },
  { id: UNALLOCATED, name: 'Unallocated', color: '#8a8a80', colorDark: '#6f6f66', synthetic: true, sortOrder: 99 },
]

const RULES: Array<Partial<typeof rules.$inferInsert> & { matchPattern: string }> = [
  // -- merchant rules (transaction level) --------------------------------
  { priority: 10, matchPattern: 'vercel|netlify|cloudflare', setProjectId: 'now-playing', setCategory: 'Utilities', setCostType: 'Hosting' },
  { priority: 10, matchPattern: 'github|linear|sentry', setProjectId: 'now-playing', setCategory: 'Office expense', setCostType: 'SaaS Platform' },
  { priority: 10, matchPattern: 'figma|adobe', setProjectId: 'triode-brand', setCategory: 'Advertising', setCostType: 'Design' },
  { priority: 10, matchPattern: 'buffer|later|hootsuite', setProjectId: 'triode-brand', setCategory: 'Advertising', setCostType: 'Social Media' },
  { priority: 10, matchPattern: 'streamelements|streamlabs|restream', setProjectId: 'twitch-channel', setCategory: 'Office expense', setCostType: 'SaaS Platform' },
  { priority: 10, matchPattern: 'beatport|bandcamp|juno download', setProjectId: 'dj-operations', setCategory: 'Supplies', setCostType: 'Music Content' },
  { priority: 10, matchPattern: 'splice|native instruments|ableton', setProjectId: 'music-production', setCategory: 'Supplies', setCostType: 'Samples' },
  { priority: 10, matchPattern: 'backblaze|dropbox|1password', setProjectId: 'infrastructure', setCategory: 'Utilities', setCostType: 'Cloud Storage' },
  { priority: 20, matchPattern: 'anthropic|openai', setProjectId: 'now-playing', setCategory: 'Office expense', setCostType: 'AI Services' },
  { priority: 30, matchPattern: 'namecheap|cloudflare registrar|google domains', setProjectId: 'infrastructure', setCategory: 'Utilities', setCostType: 'Domains' },

  // -- GCP project -> personal project (line item level) ------------------
  { priority: 10, target: 'line_item', scopeSource: 'gcp', matchPattern: '^nowplaying-', setProjectId: 'now-playing', setCategory: 'Utilities', setCostType: 'Cloud Infrastructure' },
  { priority: 10, target: 'line_item', scopeSource: 'gcp', matchPattern: '^triode-web', setProjectId: 'triode-brand', setCategory: 'Utilities', setCostType: 'Cloud Infrastructure' },
  { priority: 10, target: 'line_item', scopeSource: 'gcp', matchPattern: '^stream-overlay', setProjectId: 'twitch-channel', setCategory: 'Utilities', setCostType: 'Cloud Infrastructure' },
  { priority: 20, target: 'line_item', scopeSource: 'gcp', matchPattern: '^shared-', setProjectId: 'infrastructure', setCategory: 'Utilities', setCostType: 'Cloud Infrastructure' },

  // -- Amazon item title -> project (line item level) ---------------------
  { priority: 10, target: 'line_item', scopeSource: 'amazon', matchPattern: 'sd card|ssd|hard drive|nvme|usb-c hub|thunderbolt', setProjectId: 'infrastructure', setCategory: 'Supplies', setCostType: 'Hardware' },
  { priority: 10, target: 'line_item', scopeSource: 'amazon', matchPattern: 'xlr|microphone|shure|audio interface|headphone|monitor speaker', setProjectId: 'music-production', setCategory: 'Supplies', setCostType: 'Hardware' },
  { priority: 10, target: 'line_item', scopeSource: 'amazon', matchPattern: 'ring light|webcam|capture card|green screen|stream deck|tripod', setProjectId: 'twitch-channel', setCategory: 'Supplies', setCostType: 'Hardware' },
  { priority: 10, target: 'line_item', scopeSource: 'amazon', matchPattern: 'rca cable|dj|turntable|slipmat|flight case', setProjectId: 'dj-operations', setCategory: 'Supplies', setCostType: 'Hardware' },
  { priority: 50, target: 'line_item', scopeSource: 'amazon', matchPattern: 'book|paperback|hardcover', setProjectId: 'now-playing', setCategory: 'Other expenses', setCostType: 'Education' },
]

const SUBSCRIPTIONS = [
  ['Vercel', 2000], ['GitHub', 2100], ['Figma', 1500], ['Linear', 800],
  ['Sentry', 2900], ['StreamElements Pro', 1200], ['Splice', 999],
  ['Backblaze B2', 700], ['1Password', 799], ['Anthropic', 2000],
  ['Namecheap', 1400], ['Beatport LINK', 1799], ['Buffer', 1200],
  ['Adobe Creative Cloud', 5999], ['Cloudflare', 2500],
] as const

const AMAZON_ITEMS = [
  ['Samsung 990 PRO 2TB NVMe SSD', 17999], ['Anker USB-C Hub 8-in-1', 4999],
  ['Shure SM7B Microphone', 39900], ['Elgato Stream Deck MK.2', 14999],
  ['Neewer Ring Light 18 inch', 8999], ['SanDisk Extreme 512GB SD Card', 6499],
  ['Sony MDR-7506 Headphones', 9999], ['Hosa RCA Cable 3ft (DJ)', 1299],
  ['Designing Data-Intensive Applications (Paperback)', 4599],
  ['Elgato Cam Link 4K Capture Card', 11999],
  ['KRK Rokit 5 Monitor Speaker', 17900], ['Pioneer DJ Flight Case', 12900],
  ['Focusrite Scarlett 2i2 Audio Interface', 17999],
  ['Logitech Brio 4K Webcam', 19999],
]

const GCP_PROJECTS = [
  ['nowplaying-prod', 0.42], ['nowplaying-staging', 0.08],
  ['triode-web', 0.14], ['stream-overlay', 0.11], ['shared-observability', 0.25],
]
const GCP_SKUS = [
  ['Cloud Run', 'CPU Allocation Time'], ['Cloud Run', 'Memory Allocation Time'],
  ['Cloud Storage', 'Standard Storage US'], ['BigQuery', 'Analysis'],
  ['Cloud SQL', 'DB generic Small instance'], ['Networking', 'Egress to Internet'],
  ['Firestore', 'Document Reads'], ['Cloud Logging', 'Log Volume'],
]

// Deterministic PRNG so re-seeding produces identical data.
function rng(seed: number) {
  let s = seed
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296)
}

async function seed() {
  runMigrations()
  const rand = rng(20260805)

  await db.insert(accounts).values({
    id: 'chase-united', name: 'Chase United Explorer', institution: 'Chase',
    mask: '4471', type: 'credit',
  }).onConflictDoNothing()

  for (const p of PROJECTS) {
    await db.insert(projects).values({
      id: p.id, name: p.name, color: p.color, colorDark: p.colorDark,
      synthetic: p.synthetic ?? false, sortOrder: p.sortOrder,
    }).onConflictDoNothing()
  }

  for (const r of RULES) {
    await db.insert(rules).values({
      id: randomUUID(), priority: r.priority ?? 100,
      target: r.target ?? 'transaction', scopeSource: r.scopeSource ?? null,
      matchPattern: r.matchPattern, matchField: 'merchant_norm',
      setProjectId: r.setProjectId ?? null, setCategory: r.setCategory ?? null,
      setCostType: r.setCostType ?? null,
    }).onConflictDoNothing()
  }

  const txns: Parameters<typeof upsertTransactions>[0] = []
  const amazonItems: Parameters<typeof upsertLineItems>[1] = []
  const gcpItems: Parameters<typeof upsertLineItems>[1] = []

  const today = new Date('2026-08-05T00:00:00Z')
  const MONTHS = 14

  for (let m = MONTHS - 1; m >= 0; m--) {
    const base = new Date(today)
    base.setUTCMonth(base.getUTCMonth() - m)
    const ym = base.toISOString().slice(0, 7)
    const growth = 1 + (MONTHS - m) * 0.02 // gentle upward trend

    // ---- recurring subscriptions ----
    SUBSCRIPTIONS.forEach(([name, cents], i) => {
      const day = 1 + ((i * 3) % 27)
      const date = `${ym}-${String(day).padStart(2, '0')}`
      txns.push({
        id: `sub-${ym}-${i}`, date,
        amountCents: -Math.round(cents * (1 + rand() * 0.02)),
        merchantRaw: name, merchantNorm: normalizeMerchant(name),
        accountId: 'chase-united', copilotCategory: 'Software',
      })
    })

    // ---- GCP: daily usage rows, one monthly charge ----
    let gcpTotal = 0
    for (let day = 1; day <= 28; day += 1) {
      const date = `${ym}-${String(day).padStart(2, '0')}`
      for (const [proj, share] of GCP_PROJECTS) {
        const [service, sku] = GCP_SKUS[Math.floor(rand() * GCP_SKUS.length)]
        const cents = Math.round((80 + rand() * 260) * (share as number) * growth)
        if (cents <= 0) continue
        gcpTotal += cents
        gcpItems.push({
          externalId: `${proj}:${service}:${sku}:${date}`,
          date, amountCents: -cents,
          description: `${service} · ${sku}`, groupKey: proj as string,
          raw: { gcpProject: proj, service, sku },
        })
      }
    }
    // The invoice is net of credits and adds tax — deliberately NOT equal to
    // the metered sum, so the reconciler's scaling path gets exercised.
    const invoice = Math.round(gcpTotal * 0.94)
    const nextMonth = new Date(base)
    nextMonth.setUTCMonth(nextMonth.getUTCMonth() + 1)
    const chargeDate = `${nextMonth.toISOString().slice(0, 7)}-03`
    if (m > 0) {
      txns.push({
        id: `gcp-${ym}`, date: chargeDate, amountCents: -invoice,
        merchantRaw: 'GOOGLE *CLOUD 6M4X2Y', merchantNorm: normalizeMerchant('GOOGLE *CLOUD 6M4X2Y'),
        accountId: 'chase-united', copilotCategory: 'Software',
      })
    }

    // ---- Amazon: 1-2 orders/month, each split across shipments ----
    const orders = 1 + Math.floor(rand() * 2)
    for (let o = 0; o < orders; o++) {
      const orderId = `112-${1000000 + Math.floor(rand() * 8999999)}-${1000000 + Math.floor(rand() * 8999999)}`
      const day = 2 + Math.floor(rand() * 24)
      const orderDate = `${ym}-${String(day).padStart(2, '0')}`
      const n = 1 + Math.floor(rand() * 3)

      const picked: [string, number][] = []
      for (let k = 0; k < n; k++) {
        picked.push(AMAZON_ITEMS[Math.floor(rand() * AMAZON_ITEMS.length)] as [string, number])
      }
      picked.forEach(([title, cents], k) => {
        amazonItems.push({
          externalId: `${orderId}:${k}`, date: orderDate, amountCents: -cents,
          description: title, groupKey: orderId,
          raw: { orderId, seller: 'Amazon.com' },
        })
      })

      // Amazon charges per shipment: split the order into 1-2 captures a few
      // days later, with tax on top. This is what the subset-sum matcher has
      // to unpick — and it's why linking can't be a join.
      const subtotal = picked.reduce((a, [, c]) => a + c, 0)
      const withTax = Math.round(subtotal * 1.0875)
      const shipDay = Math.min(28, day + 1 + Math.floor(rand() * 3))
      if (picked.length > 1 && rand() > 0.5) {
        const firstCents = Math.round(picked[0][1] * 1.0875)
        txns.push({
          id: `amzn-${orderId}-a`, date: `${ym}-${String(shipDay).padStart(2, '0')}`,
          amountCents: -firstCents, merchantRaw: 'AMZN Mktp US*RT4YZ8901',
          merchantNorm: normalizeMerchant('AMZN Mktp US*RT4YZ8901'),
          accountId: 'chase-united', copilotCategory: 'Shopping',
        })
        txns.push({
          id: `amzn-${orderId}-b`, date: `${ym}-${String(Math.min(28, shipDay + 2)).padStart(2, '0')}`,
          amountCents: -(withTax - firstCents), merchantRaw: 'AMZN Mktp US*QQ12KL45',
          merchantNorm: normalizeMerchant('AMZN Mktp US*QQ12KL45'),
          accountId: 'chase-united', copilotCategory: 'Shopping',
        })
      } else {
        txns.push({
          id: `amzn-${orderId}`, date: `${ym}-${String(shipDay).padStart(2, '0')}`,
          amountCents: -withTax, merchantRaw: 'AMAZON.COM*M83KD9OL2',
          merchantNorm: normalizeMerchant('AMAZON.COM*M83KD9OL2'),
          accountId: 'chase-united', copilotCategory: 'Shopping',
        })
      }
    }

    // ---- a few genuinely unknown merchants, so the review queue isn't empty
    if (rand() > 0.4) {
      txns.push({
        id: `misc-${ym}`, date: `${ym}-17`,
        amountCents: -Math.round(1500 + rand() * 12000),
        merchantRaw: ['SP THE SOUND WELL', 'GUMROAD.COM', 'PATREON MEMBERSHIP', 'ITCH.IO'][
          Math.floor(rand() * 4)
        ],
        merchantNorm: '', accountId: 'chase-united',
      })
    }
  }

  for (const t of txns) if (!t.merchantNorm) t.merchantNorm = normalizeMerchant(t.merchantRaw)

  console.log(`seeding ${txns.length} transactions...`)
  await upsertTransactions(txns, null)
  console.log(`seeding ${amazonItems.length} amazon items, ${gcpItems.length} gcp usage rows...`)
  await upsertLineItems('amazon', amazonItems, null)
  await upsertLineItems('gcp', gcpItems, null)

  console.log('linking...')
  await runLink((m) => console.log('  ' + m))
  console.log('attributing...')
  const r = await runAttribute((m) => console.log('  ' + m))
  // Same as every real attribution path: mirror rules/overrides to config/ so
  // a fresh install already has the files you're meant to keep under git.
  await exportConfig((m) => console.log('  ' + m))
  console.log(
    `\ndone: ${r.txns} charges -> ${r.allocations} allocations, ` +
      `${(Math.abs(r.unallocatedCents) / 100).toFixed(2)} unallocated`,
  )
}

seed().catch((e) => {
  console.error(e)
  process.exit(1)
})
