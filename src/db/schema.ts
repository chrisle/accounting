import { sql } from 'drizzle-orm'
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core'

/**
 * The model rests on one separation:
 *
 *   transactions   immutable facts. what the bank says. never edited.
 *   allocations    mutable attribution. many rows per transaction.
 *
 * with one invariant, enforced in code by reconcile/invariants.ts:
 *
 *   SUM(allocations.amountCents) === transactions.amountCents   -- always
 *
 * Anything unattributed lands in the synthetic `__unallocated__` project
 * instead of vanishing, so every chart ties back to the actual bank balance
 * and "how much do I not understand yet?" is itself a number you can watch.
 */

// ---------------------------------------------------------------- projects

export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(), // slug
  name: text('name').notNull(),
  // Categorical slots are assigned in fixed order and never cycled. Dark is a
  // separately-chosen step for the dark surface, not an automatic flip.
  color: text('color').notNull().default('#2a78d6'),
  colorDark: text('color_dark').notNull().default('#3987e5'),
  status: text('status', { enum: ['active', 'archived'] })
    .notNull()
    .default('active'),
  // Synthetic buckets (__unallocated__) are excluded from "real spend" totals.
  synthetic: integer('synthetic', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
})

export const UNALLOCATED = '__unallocated__'

// ---------------------------------------------------------------- accounts

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  institution: text('institution'),
  mask: text('mask'),
  type: text('type'),
})

// ------------------------------------------------------- source documents

/**
 * Every ingested artefact: a Copilot sync snapshot, an Amazon "Request My
 * Data" ZIP, a BigQuery billing pull. Content-hashed so re-ingesting the same
 * file is a no-op rather than a duplicate.
 */
export const sourceDocuments = sqliteTable(
  'source_documents',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(), // copilot | amazon | gcp | ...
    kind: text('kind').notNull(), // snapshot | upload | query
    filename: text('filename'),
    storedPath: text('stored_path'), // under raw/, for uploads
    contentHash: text('content_hash').notNull(),
    periodStart: text('period_start'), // ISO date
    periodEnd: text('period_end'),
    rowCount: integer('row_count').notNull().default(0),
    ingestedAt: integer('ingested_at').notNull().default(sql`(unixepoch())`),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>(),
  },
  (t) => [uniqueIndex('source_documents_hash_idx').on(t.source, t.contentHash)],
)

// ------------------------------------------------------------ transactions

export const transactions = sqliteTable(
  'transactions',
  {
    // Copilot's own id, so re-syncs update in place instead of duplicating.
    id: text('id').primaryKey(),
    date: text('date').notNull(), // ISO yyyy-mm-dd
    /** Negative = money out. Integer cents, never a float. */
    amountCents: integer('amount_cents').notNull(),
    merchantRaw: text('merchant_raw').notNull(),
    merchantNorm: text('merchant_norm').notNull(),
    accountId: text('account_id').references(() => accounts.id),
    copilotCategory: text('copilot_category'),
    notes: text('notes'),
    pending: integer('pending', { mode: 'boolean' }).notNull().default(false),
    /** Set when this row reverses another (refund/return). */
    reversesTxnId: text('reverses_txn_id'),
    sourceDocId: text('source_doc_id').references(() => sourceDocuments.id),
    contentHash: text('content_hash').notNull(),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
    updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index('transactions_date_idx').on(t.date),
    index('transactions_merchant_idx').on(t.merchantNorm),
  ],
)

// -------------------------------------------------------------- line items

/**
 * Item-level rows from a breakout feed. These exist independently of any
 * transaction — Amazon ships you items before (and separately from) charging
 * you, and GCP meters usage daily but invoices monthly.
 */
export const lineItems = sqliteTable(
  'line_items',
  {
    id: text('id').primaryKey(),
    source: text('source').notNull(),
    /** amazon: `${orderId}:${asin}` · gcp: `${project}:${sku}:${usageDate}` */
    externalId: text('external_id').notNull(),
    date: text('date').notNull(),
    amountCents: integer('amount_cents').notNull(),
    quantity: real('quantity').notNull().default(1),
    description: text('description').notNull(),
    /** Free-form grouping the adapter understands: gcp project, amazon order. */
    groupKey: text('group_key'),
    raw: text('raw', { mode: 'json' }).$type<Record<string, unknown>>(),
    sourceDocId: text('source_doc_id').references(() => sourceDocuments.id),
  },
  (t) => [
    uniqueIndex('line_items_external_idx').on(t.source, t.externalId),
    index('line_items_date_idx').on(t.date),
    index('line_items_group_idx').on(t.groupKey),
  ],
)

// ------------------------------------------------------------------- links

/**
 * N:M on purpose. Amazon splits one order across several charges and merges
 * several orders into one charge; a GCP invoice covers a month of usage rows.
 * A join key would be a lie.
 */
export const txnLineLinks = sqliteTable(
  'txn_line_links',
  {
    txnId: text('txn_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    lineItemId: text('line_item_id')
      .notNull()
      .references(() => lineItems.id, { onDelete: 'cascade' }),
    confidence: real('confidence').notNull().default(1),
    method: text('method', {
      enum: ['exact', 'amount_date_fuzzy', 'invoice_period', 'manual'],
    }).notNull(),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    primaryKey({ columns: [t.txnId, t.lineItemId] }),
    index('txn_line_links_txn_idx').on(t.txnId),
  ],
)

// ------------------------------------------------------------- allocations

/**
 * The output table. Everything the dashboard draws reads from here.
 * Fully derived — wiped and rebuilt by the attribute+reconcile pass.
 */
export const allocations = sqliteTable(
  'allocations',
  {
    id: text('id').primaryKey(),
    txnId: text('txn_id')
      .notNull()
      .references(() => transactions.id, { onDelete: 'cascade' }),
    lineItemId: text('line_item_id').references(() => lineItems.id, {
      onDelete: 'set null',
    }),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id),
    category: text('category'), // Schedule C line
    costType: text('cost_type'), // SaaS / Hardware / Cloud / ...
    amountCents: integer('amount_cents').notNull(),
    basis: text('basis', {
      enum: ['direct', 'proportional', 'split_rule', 'residual', 'manual'],
    }).notNull(),
    provenance: text('provenance', {
      enum: ['rule', 'line_item', 'llm', 'human', 'fallback'],
    }).notNull(),
    confidence: real('confidence').notNull().default(1),
    ruleId: text('rule_id'),
    /** When a metered feed doesn't tie to the charge, what we scaled it by. */
    scaleFactor: real('scale_factor'),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => [
    index('allocations_txn_idx').on(t.txnId),
    index('allocations_project_idx').on(t.projectId),
  ],
)

// ------------------------------------------------------------------- rules

/**
 * Deterministic attribution, evaluated by ascending priority; first match on
 * each field wins. Editable in the UI, exported to config/rules.yaml on every
 * write so the decisions stay diffable in git.
 */
export const rules = sqliteTable(
  'rules',
  {
    id: text('id').primaryKey(),
    priority: integer('priority').notNull().default(100),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    /** What it looks at: transaction merchants, or breakout line items. */
    target: text('target', { enum: ['transaction', 'line_item'] })
      .notNull()
      .default('transaction'),
    scopeSource: text('scope_source'), // limit to one adapter, e.g. 'amazon'
    /** Case-insensitive regex over merchantNorm / line item description. */
    matchPattern: text('match_pattern').notNull(),
    matchField: text('match_field').notNull().default('merchant_norm'),
    /** Optional bounds so "over $2000 is always its own line" is expressible. */
    minCents: integer('min_cents'),
    maxCents: integer('max_cents'),
    setProjectId: text('set_project_id').references(() => projects.id),
    setCategory: text('set_category'),
    setCostType: text('set_cost_type'),
    note: text('note'),
    hits: integer('hits').notNull().default(0),
    createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
  },
  (t) => [index('rules_priority_idx').on(t.priority)],
)

// --------------------------------------------------------------- overrides

/**
 * Sticky human decisions. Keyed by a stable fingerprint rather than a row id,
 * so a re-sync that renumbers everything still can't clobber your corrections.
 * Exported to config/overrides.yaml — this is the one thing in the DB that
 * genuinely cannot be recreated.
 */
export const overrides = sqliteTable('overrides', {
  fingerprint: text('fingerprint').primaryKey(),
  scope: text('scope', { enum: ['transaction', 'line_item'] }).notNull(),
  projectId: text('project_id').references(() => projects.id),
  category: text('category'),
  costType: text('cost_type'),
  /** Percentage splits across projects: { "now-playing": 60, "twitch": 40 }. */
  splitPct: text('split_pct', { mode: 'json' }).$type<Record<string, number>>(),
  note: text('note'),
  createdAt: integer('created_at').notNull().default(sql`(unixepoch())`),
})

// ------------------------------------------------------------ source state

/** Per-connector status, powering the Sources page. */
export const sourceState = sqliteTable('source_state', {
  source: text('source').primaryKey(),
  connected: integer('connected', { mode: 'boolean' }).notNull().default(false),
  lastSyncAt: integer('last_sync_at'),
  lastSyncStatus: text('last_sync_status', {
    enum: ['ok', 'error', 'never'],
  })
    .notNull()
    .default('never'),
  lastError: text('last_error'),
  cursor: text('cursor'), // adapter-defined resume point
  config: text('config', { mode: 'json' }).$type<Record<string, unknown>>(),
})

/** Credentials, AES-256-GCM sealed with COSTS_ENCRYPTION_KEY. */
export const secrets = sqliteTable('secrets', {
  key: text('key').primaryKey(),
  ciphertext: text('ciphertext').notNull(),
  updatedAt: integer('updated_at').notNull().default(sql`(unixepoch())`),
})

// -------------------------------------------------------------------- jobs

export const jobs = sqliteTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    kind: text('kind').notNull(), // sync:copilot | ingest:amazon | attribute | ...
    status: text('status', {
      enum: ['queued', 'running', 'ok', 'error', 'cancelled'],
    })
      .notNull()
      .default('queued'),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>(),
    log: text('log').notNull().default(''),
    error: text('error'),
    queuedAt: integer('queued_at').notNull().default(sql`(unixepoch())`),
    startedAt: integer('started_at'),
    finishedAt: integer('finished_at'),
  },
  (t) => [index('jobs_status_idx').on(t.status, t.queuedAt)],
)

// -------------------------------------------------------------------- logs

/**
 * Runtime events, so the Sources page isn't the only window into what the app
 * is doing. Per-job output lives on `jobs.log`; this is the cross-cutting
 * stream — worker lifecycle, the nightly scheduler, sync failures, invariant
 * warnings. Capped by row count on write (see trimLogs) so it can't fill the
 * disk the way the deploy build cache did.
 */
export const logs = sqliteTable(
  'logs',
  {
    id: text('id').primaryKey(),
    ts: integer('ts').notNull().default(sql`(unixepoch())`),
    level: text('level', { enum: ['info', 'warn', 'error'] })
      .notNull()
      .default('info'),
    source: text('source').notNull(), // worker | scheduler | sync:copilot | ...
    message: text('message').notNull(),
    detail: text('detail'), // stack trace / json, when there's more to say
  },
  (t) => [index('logs_ts_idx').on(t.ts), index('logs_level_idx').on(t.level)],
)

export type Project = typeof projects.$inferSelect
export type Transaction = typeof transactions.$inferSelect
export type LineItem = typeof lineItems.$inferSelect
export type Allocation = typeof allocations.$inferSelect
export type Rule = typeof rules.$inferSelect
export type Job = typeof jobs.$inferSelect
export type SourceState = typeof sourceState.$inferSelect
export type LogEntry = typeof logs.$inferSelect
