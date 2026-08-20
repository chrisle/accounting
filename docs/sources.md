# Source adapters

Every cost source implements `BreakoutAdapter` in `src/lib/sources/types.ts` and
falls into one of three archetypes.

| Archetype | Example | Fan-out | Matching |
|---|---|---|---|
| `passthrough` | Figma, Vercel | 1 → 1 | merchant rule |
| `itemized` | Amazon | 1 → N items | bounded subset-sum over a settlement window |
| `metered` | Google Cloud | 1 invoice → N project×SKU | billing period + proportional |

PayPal is `itemized`: the card sees "PAYPAL *SOMESHOP", and what was bought is
only visible inside PayPal.

## The interface

```ts
interface BreakoutAdapter {
  id: string
  label: string
  archetype: 'passthrough' | 'itemized' | 'metered'
  connect: 'oauth' | 'credentials' | 'upload' | 'none'   // drives the Sources UI

  claims(txn): boolean                    // do I own breaking out this charge?
  fetch?(range, log)                      // pull line items
  fetchTransactions?(range, log)          // only the ledger source does this
  link?(txns, items, log)                 // propose txn ↔ item links
  allocate(txn, items, ctx)               // → draft allocations
}
```

`allocate()` amounts don't need to tie exactly — `reconcile()` scales or books a
residual afterwards. An adapter reports what it knows, and the reconciler is
responsible for the invariant.

`ctx.classify(text, opts)` resolves a description to a project via the rules
engine, so adapters never hard-code attribution.

## What runs unattended

| Source | Automated? |
|---|---|
| Copilot Money | Yes — a long-lived Firebase refresh token is exchanged for a 1-hour ID token, then used against Copilot's GraphQL API |
| Google Cloud | Yes — service account → BigQuery detailed billing export |
| PayPal | Yes — client-credentials token against the REST API, then Transaction Search |
| Amazon | No. A login, an OTP, and a ~24h wait for an emailed ZIP |

### Copilot Money

The ledger source. It reports that money moved, not what it bought, so `claims()`
returns `false` and every transaction it produces is offered to the other
adapters, falling through to passthrough if none take it.

Headless operation works because Firebase refresh tokens are long-lived (they
survive until revoked or the password changes) and exchanging one for an ID token
is a plain POST to Google's public `securetoken` endpoint — no browser, no
Playwright.

> **Unverified.** The GraphQL query in `copilot/client.ts` is inferred, not
> confirmed — Copilot publishes no schema. Field names follow community
> conventions, and `normalizeTxn` is tolerant of several shapes so a mismatch
> degrades to "no rows" rather than a crash. `introspect()` dumps the real schema
> so it can be corrected on first connect.

`DEFAULT_API_KEY` in `copilot/auth.ts` is the real Web API key, scraped from the
published bundle and verified against `securetoken`, so the API key field on the
Sources form is genuinely optional. `saveRefreshToken` exchanges a token before
storing it — a bad paste fails at the form instead of leaving the card reading
"connected" while every sync fails.

### Getting the credentials

```bash
ops/copilot-token.sh                  # extract + verify the Web API key
ops/copilot-token.sh <refresh-token>  # verify the token end to end
```

The Web API key is public by design — it identifies the Firebase app and
authorises nothing on its own — so the script scrapes it from the published
bundle. The bundle filename is content-hashed and changes on every Copilot
deploy, so it's located from the app shell rather than hard-coded. The script
then probes Google's `securetoken` endpoint with a bogus token: a valid key
rejects it with `INVALID_REFRESH_TOKEN`, an invalid one fails earlier with
`API_KEY_INVALID`.

The refresh token is a real credential and only comes from your own logged-in
browser. Firebase stores it in IndexedDB (`firebaseLocalStorageDb` →
`firebaseLocalStorage` → `firebase:authUser:<apiKey>:[DEFAULT]` →
`stsTokenManager.refreshToken`); run with no arguments to print a console
snippet that reads it out. It's long-lived, surviving until you change your
password or revoke sessions, so this is a per-rotation job rather than a daily
one.

Passing the token back verifies the whole chain — exchange, then a real call to
the GraphQL endpoint. `--introspect` dumps the live schema, which is how to
correct the inferred query in `client.ts`.

Copilot's API is unofficial and undocumented. Their community tooling carries a
terms-of-service caveat, and so does this.

The GraphQL query in `client.ts` was verified against the live API on
2026-08-15: `Query.transactions` is a Relay connection (`first`/`after`/`filter`,
`pageInfo`/`edges`/`node`), fields are flat (`accountId`, `categoryId`,
`isPending`, `userNotes`), and there is no `merchant`/`account`/`category`
object. Copilot reports spend as **positive** and income as **negative** — the
opposite of this ledger — so `normalizeTxn` flips the sign. `INTERNAL_TRANSFER`
rows are dropped (money between your own accounts isn't a cost). Server-side
introspection is disabled, so re-derive the schema by sending a wrong field and
reading Apollo's "Did you mean" errors (see `ops/copilot-token.sh`).

### Google Cloud

Queries the detailed billing export for daily usage by project and SKU, summing
`cost` plus credits so the figure is net of what lands on the invoice. Line items
roll up to one allocation per GCP project; per-SKU detail stays queryable in
`line_items`.

The export and the card won't tie exactly. That's expected and handled — see
[pipeline.md](pipeline.md#4-reconcile).

Needs two secrets: `gcp.service_account_json` and `gcp.billing_table`. To connect
it, create a service account with **BigQuery Data Viewer** and **BigQuery Job
User** on the project holding the detailed billing export, and put its JSON key
plus the export table name (`project.dataset.gcp_billing_export_resource_v1_XXX`)
into the `Google Cloud` item in the 1Password `Costs` vault (see
[operations.md](operations.md#secrets-1password)). The whole path — 1Password →
deploy → the secret store → `JSON.parse` → BigQuery — is wired and tested; only
the live query against a real billing table is unverified, because no such
credential exists yet.

### Amazon

Amazon retired the one-click order CSV in March 2023. Item-level data now comes
from Privacy Central → "Request My Data", which is a login, an OTP, and a ~24h
wait for an emailed ZIP. Automating that from a headless box would be brittle and
against Amazon's terms, so the UI takes the upload and nags when the data goes
stale.

The useful file inside is `Retail.OrderHistory.1/Retail.OrderHistory.1.csv`, and
the unzip is filtered so only that file is decompressed. A bare CSV also works.
Column lookup is punctuation- and case-insensitive because Amazon renames headers
between exports.

Item totals exclude the charge's tax and shipping, so `allocate()` apportions the
real charge across items by weight rather than trusting their sum. For the same
reason the adapter widens the matcher's default 6% tolerance to 9%.

## Adding a source

One folder under `src/lib/sources/`, one line in `registry.ts`, no core changes.

1. Implement `BreakoutAdapter`. Pick the archetype, and reuse `fuzzyLink` or
   `periodLink` from `matching/engine.ts` rather than writing new matching.
2. Register it: add to `ADAPTERS` (order matters — first `claims()` wins) and to
   `SYNCABLE` if the user connects it on the Sources page.
3. Add a job kind in `jobs/queue.ts` and a case in `jobs/tasks.ts` if it syncs.
4. Emit negative cents for money out, and a stable `externalId` so re-ingest
   upserts instead of duplicating.
5. Don't try to make `allocate()` tie exactly; that's `reconcile()`'s job.

### PayPal

Credentials are a client ID and secret from
[developer.paypal.com](https://developer.paypal.com/dashboard/applications/live)
→ Apps & Credentials → **Live**. They exchange for a bearer token that lasts
about nine hours; there is no user consent step and no refresh token, so it runs
unattended once stored. Sandbox credentials authenticate perfectly well and then
return no transactions, which is why `connectPaypal` verifies against the live
token endpoint before storing anything.

Two limits on `/v1/reporting/transactions` shape `client.ts`:

- **31 days per request.** `windows()` splits a longer range into contiguous
  slices, so a 120-day sync is four requests, not one rejection.
- **Page numbers, not cursors.** The response carries `total_pages`, and the
  loop walks them.

Transactions appear in the report roughly three hours after they happen, so a
sync run just after a purchase will not see it. The next run does.

Money moving between the user's own PayPal balance and their own bank — event
codes `T03xx` (funding) and `T04xx` (withdrawal) — is dropped. Counting it would
double every purchase: once as the payment, once as the withdrawal that funded
it. This is the same trap `INTERNAL_TRANSFER` avoids on the Copilot side.

PayPal signs money out as negative already, which matches this ledger, so unlike
Copilot the value passes through unflipped. The fee is a separate negative field
and is folded into the line item, because the card is charged the total.
