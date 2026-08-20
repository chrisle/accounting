# CLAUDE.md

Project-level cost attribution across Copilot Money, Amazon and Google Cloud.
One Next.js 15 app, one container, one SQLite file. Reference docs are in
`docs/`; this file is the short version.

## The invariant

```
SUM(allocations.amount_cents) === transactions.amount_cents   -- every charge, always
```

Enforced in `src/lib/reconcile/invariants.ts`. Any change that could break it
needs a test in `tests/invariants.test.ts`.

Two tables carry the model:

| | |
|---|---|
| `transactions` | Immutable facts from the bank. Never edited, only upserted. |
| `allocations` | Mutable attribution, many rows per transaction. Derived — wiped and rebuilt on every attribute pass. |

Unattributed amounts go to the synthetic `__unallocated__` project. Don't
resolve a shortfall by dropping it.

## Rules that aren't obvious from the code

- **Money is integer cents.** No floats, no `parseFloat`. Convert at render via
  `formatCents`. To split money use `apportion()` (largest-remainder), not
  `Math.round(total * pct)`.
- **Money out is negative.** Costs, purchases and usage are negative; refunds are
  positive. `src/lib/queries.ts` flips the sign for the UI.
- **Overrides are keyed by fingerprint, not row id.** Copilot renumbers rows and
  a re-requested Amazon export produces fresh ids, so keying on ids would
  discard the user's corrections on every sync. See
  `src/lib/attribution/overrides.ts`.
- **`allocations` is a cache.** It has to be reproducible from transactions +
  line items + rules + overrides. Don't store anything there that exists nowhere
  else.
- **Overrides are the only irreplaceable data.** They mirror to
  `$COSTS_DATA_DIR/config/*.yaml` on every attribute pass so they stay diffable.
  Don't add state that breaks that.
- **Secrets resolve in layers** (`src/lib/secrets.ts`): live 1Password (`op`,
  when a scoped token is set) → AES-SQLite (UI writes, rotation) → deploy-injected
  env (`COSTS_SECRET_*_B64`, seeded from the 1Password `Costs` vault by
  `deploy.sh`). 1Password is the source of truth; the env seed is how secrets
  reach the container today without a token in it. See `docs/operations.md`.
- **Logging must never throw.** `logEvent` swallows its own failures — a broken
  logger degrades to console output, it never takes down a sync.

## Commands

```bash
npm run dev                    # localhost:3000
npm test                       # 46 tests, node:test via tsx
npm run db:migrate             # apply migrations
npm run db:seed                # 14 months of demo data (see below)
npm run db:reset               # rm the db, migrate, seed
npm run db:generate            # new migration after editing src/db/schema.ts
ops/proxmox/deploy.sh          # deploy to the Proxmox LXC (docs/operations.md)
```

## When something is unknown or ambiguous, test it

Don't answer from reading the code when you can run it. Reading has produced
confident wrong answers here more than once, and testing is cheap:

- **Throwaway database.** Point `COSTS_DATA_DIR` at a temp dir, set
  `COSTS_ENCRYPTION_KEY`, call `runMigrations()`. Nothing touches `./data`.
- **Mock the network.** Replacing `globalThis.fetch` in a `tsx` script drives a
  whole source path — token exchange, pagination, normalisation, the ledger
  write — with no credentials and no live API.
- **Probe third-party endpoints** rather than reasoning about them. The
  difference between two error codes is often the entire answer:
  `API_KEY_INVALID` vs `INVALID_REFRESH_TOKEN` is how the shipped Firebase key
  was found to be a placeholder.
- **Query the database** before describing what's in it. `secrets` and
  `source_documents` being empty tells you the dashboard is showing seed data.
- **Check the actual string.** Run `normalizeMerchant` or `toCents` on real
  inputs instead of predicting what they return.

When a test contradicts what you expected, work out which side is wrong before
changing either. In one session that split three ways: the `accounts` foreign
key was a real bug, while two failing assertions about `toCents` rounding and
merchant normalisation were wrong expectations about correct-enough code.

Say which claims are verified and which aren't, and name the evidence. Delete
scratch harnesses when you're done with them.

## Known traps

- **better-sqlite3 11.x crashes on Node 24.** `Assertion failed: (env) != nullptr`
  in `Statement::~Statement()` — SIGABRT mid-query, not a warning. The Dockerfile
  pins `node:22-bookworm-slim` because of this. The fix is better-sqlite3 >= 12,
  which would let the pin go. Local dev on Node 24 runs the same pairing and
  hasn't crashed, but it's the same bug.
- **`public/` is empty and git can't track an empty directory**, while the
  Dockerfile `COPY`s it and buildkit fails on a missing source path. Any deploy
  path that syncs via `git ls-files` has to `mkdir -p public`.
- **`pct exec` runs execvp with no shell**, so builtins like `command -v`, plus
  globs and pipes, need an explicit `bash -lc`.
- **The dev server compiles `instrumentation.ts` for the edge runtime**, which has
  no Node built-ins and ignores `serverExternalPackages`. `next.config.ts` aliases
  the worker module to `false` for edge to cut the import chain. Removing that
  webpack block breaks `npm run dev` while `npm run build` stays green.
- **Server actions call `runAttribute()` synchronously** (`src/actions/rules.ts`).
  Acceptable at this data size; if the ledger grows, enqueue a job instead.

## The data in a fresh install is fake

`npm run db:seed` writes 14 months of synthetic transactions so the dashboard has
something to draw before anything is connected. IDs are prefixed `sub-`, `amzn-`,
`gcp-`, `misc-`, and the account "Chase United Explorer ••4471" is invented. Real
data requires connecting sources on `/sources`. Before answering questions about
the numbers, check whether `secrets` and `source_documents` are empty — if they
are, everything on screen is seed data.

## Layout

```
src/
├── instrumentation.ts     boots worker + nightly scheduler
├── db/schema.ts           the model
├── lib/
│   ├── money.ts           integer cents + largest-remainder apportionment
│   ├── reconcile/         the invariant
│   ├── matching/engine.ts subset-sum + period linking
│   ├── attribution/       rules engine, sticky overrides
│   ├── sources/           one folder per adapter
│   ├── secrets.ts         layered resolver: 1Password → AES-SQLite → env seed
│   ├── logs.ts            runtime event log (rolling, rowid-trimmed)
│   ├── pipeline.ts        link → attribute → reconcile → write
│   └── jobs/              queue, tasks, in-process worker
└── app/                   overview · projects · review · sources · rules · logs
```

## Conventions

- Comments explain why, not what, and match the existing density. A comment that
  restates the line below it doesn't belong.
- Adding a cost source is one folder under `src/lib/sources/` implementing
  `BreakoutAdapter`, plus a line in `registry.ts`. No core changes. See
  `docs/sources.md`.
- The Drizzle schema is the source of truth; migrations are generated, not
  hand-written.
- No new runtime dependencies without a reason that survives "can SQLite or the
  standard library do this?"
