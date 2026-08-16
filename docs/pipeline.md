# The pipeline

`src/lib/pipeline.ts`. Four stages, run in order by the `sync:all` job:

```
fetch  →  link  →  attribute  →  reconcile  →  write
```

## 1. Fetch

Per-source, in `src/lib/jobs/tasks.ts`. Copilot produces transactions; GCP and
Amazon produce line items. The default window is 120 days, long enough to catch
late-posting and amended rows. Everything upserts on a natural key, so re-running
is idempotent.

Sources are independent: in `sync:all` one failing doesn't stop the others, and
attribution still runs on whatever landed.

## 2. Link

`runLink()` rebuilds `txn_line_links` wholesale for every adapter implementing
`link()`. It's cheap enough to redo entirely, and doing so means a corrected or
re-uploaded export doesn't leave stale links behind.

Two strategies, in `src/lib/matching/engine.ts`:

**`fuzzyLink` — bounded subset-sum** (Amazon). Amazon charges per shipment rather
than per order, merges unrelated orders into one capture, applies gift-card
balance silently, and settles days later. So this is a subset-sum over a
settlement window rather than a join.

- Exact single-item match is tried first — the common case, and unambiguous.
- Otherwise a depth-first walk over the 18 largest candidates, pruned when the
  running sum overshoots or the remainder can't close the gap.
- Charges are processed largest-first so a big charge isn't starved by small
  greedy matches, and a line item is never assigned to two charges.
- Returns `null` rather than guessing. Unmatched charges go to the review queue.
  Expect roughly 85% auto-match.

**`periodLink` — billing period** (GCP). A charge posted in month M almost always
bills usage from M-1. No amount matching, because the amounts won't agree.

## 3. Attribute

`runAttribute()` wipes and rebuilds allocations. Precedence, highest first:

1. **Transaction override** — a human said so, including percentage splits.
2. **Breakout adapter** — Amazon items, GCP projects, with per-item overrides
   applied on top.
3. **Passthrough merchant rules** — for unclaimed charges, and as the fallback
   when a breakout adapter claimed a charge but produced nothing (an Amazon
   charge whose order export hasn't been uploaded yet).
4. **Residual** → `__unallocated__`.

Rules themselves fill fields independently by ascending priority — see
[data-model.md](data-model.md#rules).

## 4. Reconcile

`src/lib/reconcile/invariants.ts` forces `SUM(allocations) === txn.amountCents`.
Four cases:

| Situation | What happens |
|---|---|
| Nothing attributed | One residual row on `__unallocated__` |
| Sum off by ≤ 2%, same sign | Scale proportionally onto the real charge, record `scale_factor` |
| Sum off by more | Keep what's known, book a residual for the rest |
| Sum off by cents | Largest-remainder apportionment absorbs it exactly |

The 2% tolerance handles metered feeds: GCP meters daily usage, the card sees a
monthly invoice net of credits, tax and FX. The scaling is recorded rather than
hidden, so the drift stays auditable.

`assertBalanced()` runs before every write. If it throws, that's a logic bug
rather than bad data.

## 5. Write

Deletes and re-inserts inside a single SQLite transaction, chunked at 500 rows,
so the invariant holds from the outside at every instant and a dashboard read
during a rebuild never sees a partial ledger.

Then `exportConfig()` mirrors rules, overrides and projects to
`$COSTS_DATA_DIR/config/*.yaml`.

## The job runner

`src/lib/jobs/` — a `jobs` table, a 2-second poll loop, one job at a time.

| Kind | Does |
|---|---|
| `sync:copilot` | Fetch transactions from the Copilot GraphQL API |
| `sync:gcp` | Query the BigQuery billing export |
| `ingest:amazon` | Fold an already-parsed upload into the ledger |
| `link` | Rebuild all txn ↔ line-item links |
| `attribute` | Rebuild all allocations, then export config |
| `sync:all` | All of the above in order; what the nightly scheduler enqueues |

Job logs append to the row and stream to the Sources page via `/api/jobs`.

## Known rough edge

The "% needs triage" figure logged at the end of an `attribute` job
(`src/lib/jobs/tasks.ts`) computes `|unallocated| / (|unallocated| + 1)`, which is
always about 100%. It's cosmetic — a log line only — and doesn't affect the
`coverage` figure on the dashboard, which `src/lib/queries.ts` computes correctly
as `1 - unallocated/total`.
