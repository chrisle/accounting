import { asc } from 'drizzle-orm'
import { db, rules as rulesTable, type Rule } from '@/db'
import type { Cents } from '@/lib/money'

export type Classification = {
  projectId: string | null
  category: string | null
  costType: string | null
  ruleId: string | null
}

const EMPTY: Classification = {
  projectId: null,
  category: null,
  costType: null,
  ruleId: null,
}

/**
 * Strip payment-processor noise so rules match the merchant, not the receipt.
 *
 * The result is load-bearing twice over: rules regex against it, and the
 * `merchant:` override fingerprint hashes it. So a merchant that normalises to
 * the empty string is worse than one that normalises badly — it matches no rule,
 * and it collides with every other emptied merchant, which would make one
 * override silently reattribute unrelated charges.
 */
export function normalizeMerchant(raw: string): string {
  const out = raw
    .toLowerCase()
    .replace(/\b(sq|tst|pp|paypal|sp|amzn mktp|amzn|wl)\s*\*/g, '')
    .replace(/\b(purchase|payment|recurring|autopay|pos|debit|credit)\b/g, '')
    // "AMZN Mktp US*2H4XY9" puts the order token after the locale, so the
    // prefix rule above never fires on it. Left in, the token is per-order and
    // every Amazon charge gets its own fingerprint.
    .replace(/\bamzn mktp [a-z]{2}\*[a-z0-9]+/g, 'amzn mktp')
    .replace(/\bamazon\.com\*[a-z0-9]+/g, 'amazon.com')
    // Order/auth ids. Requiring a digit is what keeps this from eating ordinary
    // one-word merchants — "cloudflare", "squarespace" and "youtubepremium" are
    // all 10+ characters and were being blanked entirely.
    .replace(/\b(?=[a-z0-9]*\d)[a-z0-9]{10,}\b/g, ' ')
    .replace(/\b\d{3}-\d{7}-\d{7}\b/g, ' ') // amazon order numbers
    .replace(/#\S+/g, ' ')
    .replace(/[^a-z0-9&.\- ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  // Never hand back an empty string: fall back to a minimally-cleaned form so
  // the merchant stays distinguishable even if every rule above stripped it.
  if (out) return out
  return (
    raw
      .toLowerCase()
      .replace(/[^a-z0-9&.\- ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'unknown'
  )
}

/**
 * Deterministic attribution. Rules are evaluated by ascending priority and
 * fields fill in independently — a low-priority rule can still supply the cost
 * type that a high-priority project rule left blank. That lets you keep broad
 * "anything from Google Cloud is Infrastructure" rules alongside narrow
 * "this specific SKU is Now Playing" ones without them fighting.
 */
export class RuleEngine {
  constructor(private readonly all: Rule[]) {}

  static async load(): Promise<RuleEngine> {
    const rows = await db
      .select()
      .from(rulesTable)
      .orderBy(asc(rulesTable.priority))
    return new RuleEngine(rows.filter((r) => r.enabled))
  }

  classify(
    text: string,
    opts: {
      source?: string
      amountCents?: Cents
      target?: 'transaction' | 'line_item'
    } = {},
  ): Classification {
    const target = opts.target ?? 'transaction'
    const haystack = text.toLowerCase()
    const abs = opts.amountCents != null ? Math.abs(opts.amountCents) : null
    const out: Classification = { ...EMPTY }

    for (const r of this.all) {
      if (r.target !== target) continue
      if (r.scopeSource && r.scopeSource !== opts.source) continue
      if (abs != null) {
        if (r.minCents != null && abs < r.minCents) continue
        if (r.maxCents != null && abs > r.maxCents) continue
      }

      let hit = false
      try {
        hit = new RegExp(r.matchPattern, 'i').test(haystack)
      } catch {
        continue // a bad regex typed in the UI must not break the pipeline
      }
      if (!hit) continue

      if (!out.projectId && r.setProjectId) {
        out.projectId = r.setProjectId
        out.ruleId = r.id
      }
      if (!out.category && r.setCategory) out.category = r.setCategory
      if (!out.costType && r.setCostType) out.costType = r.setCostType

      if (out.projectId && out.category && out.costType) break
    }
    return out
  }
}
