# Data model

The schema is in `src/db/schema.ts` (Drizzle, SQLite). Migrations are generated
from it with `npm run db:generate`, not hand-written.

## Conventions

**Money is integer cents.** Column type is `integer`, never `real`. Convert at
render via `formatCents()`.

**Money out is negative.** Purchases, costs and metered usage are negative;
refunds and credits are positive. Adapters have to follow this, since the
invariant depends on an unambiguous sign convention. `src/lib/queries.ts` flips
the sign so the UI works in positive spend.

**Dates are ISO `yyyy-mm-dd` text.** Timestamps are unix integers
(`unixepoch()`), not ISO strings.

## Tables

### `transactions`

What the bank says, via the ledger source. The primary key is Copilot's own id,
so a re-sync updates in place instead of duplicating.

| Column | Notes |
|---|---|
| `id` | Upstream id. Stable within a source but not across a reconnect, so don't key human decisions on it |
| `date` | ISO date |
| `amount_cents` | Negative = money out |
| `merchant_raw` | As the bank reported it |
| `merchant_norm` | Processor noise stripped (`normalizeMerchant`); what rules match against |
| `reverses_txn_id` | Set when this row reverses another (refund/return) |
| `content_hash` | sha256 of id+date+amount+merchant, for change detection |

Attribution never edits this table.

### `line_items`

Item-level rows from a breakout feed, stored independently of any transaction.
Amazon ships items before and separately from charging; GCP meters daily but
invoices monthly.

| Column | Notes |
|---|---|
| `source` | `amazon` \| `gcp` \| … |
| `external_id` | Adapter-defined natural key. Amazon: `${orderId}:${asin}:${n}` · GCP: `${project}:${service}:${sku}:${day}`. Unique per source, so re-ingest upserts |
| `group_key` | Grouping the adapter understands: GCP project, Amazon order id |
| `raw` | JSON passthrough of the source's own fields |

### `txn_line_links`

N:M. Amazon splits one order across charges and merges orders into one capture; a
GCP invoice covers a month of usage. Carries `confidence` and `method`
(`exact` \| `amount_date_fuzzy` \| `invoice_period` \| `manual`).

### `allocations`

What the dashboard reads. Wiped and rebuilt by the attribute pass, swapped in
inside one SQLite transaction so a concurrent read never sees a half-attributed
ledger.

| Column | Notes |
|---|---|
| `basis` | `direct` \| `proportional` \| `split_rule` \| `residual` \| `manual` — how the amount was arrived at |
| `provenance` | `rule` \| `line_item` \| `llm` \| `human` \| `fallback` — who decided |
| `confidence` | Drives the review queue (`< 0.8` surfaces) |
| `scale_factor` | Set when a metered feed had to be scaled onto the real charge |
| `category` | Schedule C line |
| `cost_type` | SaaS / Hardware / Cloud Infrastructure / … |

### `rules`

Evaluated by ascending priority, with fields filling in independently: a
low-priority rule can supply the cost type that a high-priority project rule left
blank. That lets broad rules ("anything from Google Cloud is Infrastructure")
coexist with narrow ones ("this SKU is Now Playing").

`target` is `transaction` (matches `merchant_norm`) or `line_item` (matches the
item description), optionally scoped to one adapter via `scope_source`.
`match_pattern` is a case-insensitive regex; an invalid one is skipped rather than
fatal, since it's typed in the UI.

### `overrides`

The one table nothing upstream can regenerate. Keyed by a stable fingerprint
rather than a row id:

| Fingerprint | Built from | Meaning |
|---|---|---|
| `txn:` | `merchantNorm` + `amountCents` | this exact charge |
| `merchant:` | `merchantNorm` | this merchant at any amount (recurring subs) |
| `li:` | `source` + identity (GCP: `groupKey`; Amazon: description) | this item or cloud project |

`split_pct` holds percentage splits across projects (`{"now-playing": 60,
"twitch": 40}`) for shared infrastructure. Mirrored to `config/overrides.yaml` on
every attribute pass.

### `projects`

Slug ids. `synthetic` marks buckets excluded from real-spend totals — currently
just `__unallocated__`, which uses neutral gray rather than a categorical hue
because it represents missing data rather than a category.

### `source_documents`

Every ingested artefact: a Copilot snapshot, an Amazon ZIP, a BigQuery pull.
Content-hashed and uniquely indexed on `(source, content_hash)`, so re-ingesting
the same file is a no-op.

### `source_state` and `secrets`

Per-connector status for the Sources page, and credentials sealed with AES-256-GCM
under `COSTS_ENCRYPTION_KEY`. The key never touches the database. A decryption
failure is treated as "disconnected" rather than crashing the sync, so a rotated
key degrades gracefully.

### `jobs`

Queue rows with an appended `log` column. One queued job per kind, so clicking
"Sync now" five times doesn't run five syncs.

## Reading it directly

```bash
# local
sqlite3 data/costs.db "select count(*) from allocations"

# on the container (no sqlite3 CLI there; go through node)
ssh root@proxmox 'pct exec 121 -- docker exec costs \
  node -e "const d=new (require(\"/app/node_modules/better-sqlite3\"))(\"/data/costs.db\",{readonly:true}); \
  console.log(d.prepare(\"select count(*) c from transactions\").get())"'
```

Node resolves `node_modules` from the script's own directory, so a script placed
outside `/app` needs an absolute module path.
