# Development

## Setup

```bash
npm install
cp .env.example .env.local              # set COSTS_ENCRYPTION_KEY
npm run db:migrate && npm run db:seed   # 14 months of demo data
npm run dev                             # localhost:3000
```

## Commands

| | |
|---|---|
| `npm run dev` | Next dev server on :3000 |
| `npm test` | 20 tests, `node:test` via tsx |
| `npm run build` | Production build (`output: 'standalone'`) |
| `npm run db:generate` | Generate a migration after editing `src/db/schema.ts` |
| `npm run db:migrate` | Apply migrations |
| `npm run db:seed` | Seed demo data |
| `npm run db:reset` | Delete the db, migrate, seed |

## Tests

`tests/invariants.test.ts` covers apportionment (parts always sum to the total
exactly) and every reconcile branch: no drafts → residual, already-ties →
untouched, within-tolerance → scaled, large gap → residual, over-allocation
corrected, refunds, and `assertBalanced` throwing on a one-cent discrepancy.

`tests/matching.test.ts` covers subset-sum: exact single match, merged shipments,
tax within tolerance, the settlement window, never assigning one item to two
charges, and returning `null` rather than guessing.

Any change that could affect the invariant needs a test here.

## The seed data is fake

`npm run db:seed` writes synthetic transactions so the dashboard has something to
draw before anything is connected. Transaction ids are prefixed `sub-`, `amzn-`,
`gcp-` and `misc-`; the account "Chase United Explorer ••4471" is invented; some
rows are deliberately future-dated relative to the seeding date.

Before drawing conclusions from what's on screen:

```sql
select count(*) from secrets;           -- 0 = no source ever connected
select count(*) from source_documents;  -- 0 = nothing ever ingested
```

## Traps

**better-sqlite3 11.x crashes on Node 24.** `Assertion failed: (env) != nullptr` in
`node::RemoveEnvironmentCleanupHook`, raised from `Statement::~Statement()`. It's a
SIGABRT mid-query, not a warning — it killed the server six times in ten minutes
on the first deploy and took `db:seed` down partway through. The Dockerfile pins
`node:22-bookworm-slim` because of it.

better-sqlite3 11.x declares no `engines`; 12.5.0 is the first release listing
`24.x`. The fix is bumping to >= 12, which would let the pin go. Local dev on Node
24 runs the same pairing and hasn't aborted, but it's the same bug.

**`public/` is empty.** Git can't track an empty directory, while the Dockerfile
`COPY`s it and buildkit fails on a missing source. Any deploy path syncing via
`git ls-files` has to `mkdir -p public`.

**The edge runtime compiles `instrumentation.ts` in dev.** A production build drops
that entry when no edge routes exist; dev keeps it. The edge compiler has no Node
built-ins and ignores `serverExternalPackages`, so the worker → tasks → registry →
BigQuery chain fails to compile. `register()` guards on `NEXT_RUNTIME`, and
`next.config.ts` aliases the resolved worker path to `false` for edge to cut the
chain before webpack touches Node-only code. Removing that webpack block breaks
`npm run dev` while leaving `npm run build` green.

**Server actions re-attribute synchronously.** `createRule`, `toggleRule` and
`deleteRule` call `runAttribute()` inline. Acceptable at this data size; if the
ledger grows, enqueue an `attribute` job instead.

**Two dev servers, one port.** If something else already holds :3000, Next binds
the same port on IPv6 and requests may reach either process. Use `npm run dev --
-p 3001`, or check with `lsof -nP -iTCP:3000 -sTCP:LISTEN`.

## Working on the code

- Comments explain why, not what, and match the existing density. The codebase
  documents decisions and trade-offs, not syntax.
- Integer cents everywhere, and `apportion()` for any split. Never
  `Math.round(total * pct)` across multiple buckets.
- Money out is negative, in every adapter.
- Never key a human decision on an upstream row id; fingerprint it. See
  `src/lib/attribution/overrides.ts`.
- `allocations` has to stay fully derivable. Nothing may live there and nowhere
  else.
- Adding a source is one folder plus a registry line — see
  [sources.md](sources.md#adding-a-source).
