# Costs

Project-level cost attribution across Copilot Money, Amazon and Google Cloud.
One Next.js app, one container, one SQLite file. Runs on Proxmox, reachable from
a browser over Tailscale.

## The idea

A bank transaction is a rollup that lies about where the money went. One $340
Amazon charge is six items across three projects. One $210 Google Cloud charge is
forty SKUs across five projects. So the model separates two things most finance
apps conflate:

| | |
|---|---|
| `transactions` | immutable facts. what the bank says. never edited. |
| `allocations` | mutable attribution. many rows per transaction. |

with one invariant, enforced in `src/lib/reconcile/invariants.ts`:

```
SUM(allocations.amount_cents) === transactions.amount_cents    -- for every charge, always
```

Anything unattributed lands in a synthetic `__unallocated__` project rather than
vanishing. That's what makes the dashboard trustworthy: every chart ties back to
the actual bank balance, and *"how much do I not understand yet?"* is itself a
number you can watch shrink.

## Source adapters

Each cost source implements one interface (`src/lib/sources/types.ts`) and falls
into one of three archetypes:

| Archetype | Example | Fan-out | Matching |
|---|---|---|---|
| passthrough | Figma, Vercel | 1 → 1 | merchant rule |
| itemized receipt | Amazon | 1 → N items | bounded subset-sum over a date window |
| metered usage | Google Cloud | 1 invoice → N project×SKU | billing period + proportional |

Adding Cloudflare later is one folder under `src/lib/sources/` and no changes to
the core.

### What runs unattended, and what can't

| Source | Automated? |
|---|---|
| **Copilot Money** | Yes — a long-lived Firebase refresh token is exchanged for a 1-hour ID token against Google's public securetoken endpoint, then used on Copilot's GraphQL API. |
| **Google Cloud** | Yes — service account → BigQuery detailed billing export. |
| **Amazon** | **No.** The item-level export is a login, an OTP, and a ~24h wait for an emailed ZIP. Upload it on the Sources page; the UI nags when it goes stale. |

Copilot's API is unofficial and undocumented. Their community tooling carries a
terms-of-service caveat, and so does this. The GraphQL query in
`src/lib/sources/copilot/client.ts` is **inferred, not verified** — the response
normaliser is deliberately tolerant, and `introspect()` will dump the real schema
so you can correct it on first connect.

## The hard parts, and what handles them

1. **Amazon charges ≠ Amazon orders.** Amazon charges per *shipment*, merges
   unrelated orders into one capture, applies gift-card balance silently, and
   settles days later. `src/lib/matching/engine.ts` runs a pruned subset-sum over
   a settlement window. Anything that doesn't resolve is left unlinked and shows
   up in the review queue rather than being guessed at. Expect ~85% auto-match.
2. **Google Cloud will never tie out exactly.** The export meters daily usage;
   the card sees a monthly invoice net of credits, tax and FX. The reconciler
   scales allocations onto the real charge and records the `scale_factor`, so the
   drift stays auditable instead of quietly baked in.
3. **Refunds** are negative transactions that reconcile through the same path.
4. **Shared infrastructure.** One GCP project serving three personal projects is
   a percentage split (`splitCharge` → `overrides.split_pct`).

## Layout

```
src/
├── instrumentation.ts        boots the worker + nightly scheduler (the whole orchestration layer)
├── db/schema.ts              the model above
├── lib/
│   ├── money.ts              integer cents + largest-remainder apportionment
│   ├── reconcile/            the invariant
│   ├── matching/engine.ts    subset-sum + period linking
│   ├── attribution/          rules engine, sticky overrides
│   ├── sources/              one folder per adapter
│   ├── pipeline.ts           link → attribute → reconcile → write
│   └── jobs/                 queue, tasks, in-process worker
└── app/                      overview · projects · review · sources · rules
```

`/data` holds `costs.db`, `raw/` (uploaded exports) and `config/` (YAML mirrors
of your rules and overrides).

## Precious vs. derived

Sort every file by *can I recreate this?*

| | Recreatable | Where |
|---|---|---|
| Rules, **overrides** | No — human judgement | `/data/config/*.yaml` — **put this under git** |
| Amazon ZIPs, Copilot snapshots | No — point-in-time | `/data/raw/` |
| `costs.db` | **Yes**, from raw + config | `/data/costs.db` |

Overrides are written through to YAML on every attribution pass, which keeps the
database genuinely disposable — and gives every correction you make a diff and a
history.

## Running it

```bash
npm install
cp .env.example .env.local          # set COSTS_ENCRYPTION_KEY
npm run db:migrate && npm run db:seed   # 14 months of demo data
npm run dev
```

Tests — the invariant suite is the highest-value thing in the repo:

```bash
npm test
```

### Proxmox

```bash
scp ops/proxmox/bootstrap.sh root@proxmox:/tmp/
ssh root@proxmox bash /tmp/bootstrap.sh
```

Creates an unprivileged LXC with `nesting=1`, bind-mounts a ZFS dataset at
`/srv/costs`, and installs Docker and Tailscale. It then prints the handful of
steps that need a credential or a decision. `tailscale serve 3000` gives you TLS
and tailnet-membership auth with no port forwarding and no password.

Don't expose this to the internet. It holds a complete picture of your finances.

## The loop that matters

The review queue exists to turn one-off corrections into durable rules. Assigning
a project writes a **sticky override keyed to a stable fingerprint** — not a row
id, because Copilot renumbers things and a re-requested Amazon export produces
fresh ids. Tick *"also create a rule"* and the next charge like it never reaches
the queue at all.

The system should get more accurate every week without you writing any code.
