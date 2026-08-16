# Architecture

## The problem

A bank transaction is a rollup. One $340 Amazon charge can be six items across
three projects; one $210 Google Cloud charge can be forty SKUs across five.
Personal finance tools categorise the charge. This app attributes the money
underneath it.

## The two-table split

Two things behave differently enough to keep separate:

| | |
|---|---|
| `transactions` | Immutable facts. What the bank says. Never edited, only upserted from the ledger source. |
| `allocations` | Mutable attribution. Many rows per transaction. Derived — wiped and rebuilt on every attribute pass. |

With one invariant, enforced in `src/lib/reconcile/invariants.ts`:

```
SUM(allocations.amount_cents) === transactions.amount_cents   -- for every charge, always
```

Anything unattributed goes to a synthetic `__unallocated__` project rather than
disappearing. That keeps every chart tied to the actual bank balance, and makes
"how much do I not understand yet?" a number you can watch shrink.

Because allocations are derived, they're effectively a cache: reproducible from
transactions + line items + rules + overrides, which is what makes the database
disposable.

## Layers

```
                    ┌──────────────────────────────────────┐
   Copilot Money ──►│ transactions   (immutable, upserted) │
                    └──────────────────┬───────────────────┘
                                       │
   Amazon ZIP    ──►┌──────────────┐   │   link (subset-sum / billing period)
   GCP BigQuery  ──►│  line_items  │───┼──►  txn_line_links
                    └──────────────┘   │
                                       ▼
                    rules + overrides ──►  attribute  ──►  reconcile
                                                              │
                                                              ▼
                                                        allocations
                                                              │
                                                              ▼
                                                     dashboard queries
```

The UI never reads `transactions` directly for money figures. Every number comes
from `allocations` (`src/lib/queries.ts`), so a project total and the bank
statement can't silently disagree.

## Orchestration

There's no sidecar, cron container or queue broker. `output: 'standalone'` makes
the Next server a long-lived Node process, so `src/instrumentation.ts` — which
Next calls once at boot — runs migrations and starts an in-process worker:

- a 2-second poll loop draining a `jobs` table (`src/lib/jobs/worker.ts`)
- a nightly `sync:all` at `COSTS_SYNC_AT` (default 04:15 local; `off` disables it)

It's single-flight: one job at a time, one process. SQLite works well that way
and a single user has nothing to contend over. A crash mid-job leaves a zombie
`running` row, which `reapStale()` clears at boot.

## Design decisions

**Integer cents.** Floating point makes the invariant unenforceable — `1.005 *
100` is `100.49999999999999` in IEEE-754, which rounds down and loses a cent.
`src/lib/money.ts` normalises through a fixed-precision string, and splits use
largest-remainder apportionment so the parts sum to exactly the total.

**N:M between charges and line items.** Amazon splits one order across several
charges and merges several orders into one charge; a GCP invoice covers a month
of usage rows. A foreign key would misrepresent that, so `txn_line_links` carries
the relationship plus a confidence and a method.

**Metered feeds won't tie to the invoice.** The GCP billing export meters usage by
day; the card sees a monthly invoice net of committed-use discounts, credits, tax
and FX. Rather than chase equality, `reconcile()` scales allocations onto the real
charge and records the `scale_factor`, so the drift stays auditable.

**Unmatched rather than guessed.** The subset-sum matcher returns `null` instead
of picking a plausible but wrong subset. Unresolved charges surface in the review
queue, where a human decision becomes a durable override.

## Review queue and overrides

The review queue turns one-off corrections into rules. Assigning a project writes
a sticky override keyed to a stable fingerprint rather than a row id, because
Copilot renumbers rows and a re-requested Amazon export produces fresh ids.
Ticking "also create a rule" writes a pattern too, so the next similar charge
never reaches the queue.

## Precious vs. derived

Sort every file by whether you could recreate it:

| | Recreatable | Where |
|---|---|---|
| Rules, overrides | No — human judgement | `$COSTS_DATA_DIR/config/*.yaml` — put this under git |
| Amazon ZIPs, Copilot snapshots | No — point-in-time | `$COSTS_DATA_DIR/raw/` |
| `costs.db` | Yes, from raw + config | `$COSTS_DATA_DIR/costs.db` |

Overrides are written to YAML on every attribution pass, which keeps the database
disposable and gives each correction a diff and a history.
