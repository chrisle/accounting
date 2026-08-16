# Operations

## Where it runs

Proxmox CT 121, hostname `accounting`, tagged `apps`, at
**http://accounting:8000** over plain HTTP on the LAN.

> The root README and `ops/proxmox/bootstrap.sh` describe a Tailscale-fronted,
> tailnet-only deployment on CT 120 `costs` with a ZFS bind mount. That path is
> accurate as written but isn't what's currently running. The LAN deployment
> below is. There's no TLS and no auth in front of it, so don't expose it beyond
> the LAN — it holds a complete picture of your finances.

| | |
|---|---|
| Source | `/opt/costs` on the CT |
| Data | `/srv/costs` on the CT rootfs (uid 1001), not a bind mount |
| Published port | `0.0.0.0:8000` → container `3000` |
| Secrets | `/opt/costs/.env`, backed up nowhere else |

## Deploying

```bash
ops/proxmox/deploy.sh
```

Runs from a checkout on the Mac. Everything goes through `ssh root@proxmox` and
`pct exec`, because the container has no git remote and no rsync.

It's idempotent and safe to re-run. It finds the CT by hostname rather than a
hard-coded id, creates and docker-installs it if missing, forces the `apps` tag,
writes `compose.override.yaml`, ships the working tree via `git ls-files | tar`,
rebuilds, and polls `/api/health`. It doesn't touch `/srv/costs` and doesn't
regenerate an existing `.env`.

Knobs, all environment variables: `PVE_HOST`, `CT_NAME`, `CT_TAG`, `PORT`,
`APP_DIR`, `DATA_DIR`, plus `NEW_CTID`/`CORES`/`MEMORY`/`ROOTFS`/`TEMPLATE` used
only when creating a container.

```bash
PORT=8080 ops/proxmox/deploy.sh          # different port
CT_NAME=accounting-staging NEW_CTID=131 ops/proxmox/deploy.sh
```

Because it ships `git ls-files`, uncommitted changes deploy but untracked files
don't. `git add` a new file before deploying it.

## Environment

| Variable | Default | Notes |
|---|---|---|
| `COSTS_DATA_DIR` | `./data` | `/data` in the container |
| `COSTS_ENCRYPTION_KEY` | — | Required. 32 bytes base64: `openssl rand -base64 32` |
| `COSTS_SYNC_AT` | `04:15` | Local 24h time. `off` disables the scheduler |
| `COSTS_TZ` | `America/Los_Angeles` | |
| `ANTHROPIC_API_KEY` | unset | Optional LLM fallback for uncategorised items. Unset means attribution is purely deterministic |

Losing `COSTS_ENCRYPTION_KEY` means reconnecting your sources. It doesn't cost you
any cost history, and a wrong key is treated as "disconnected" rather than
crashing.

## Secrets (1Password)

1Password is the source of truth for source credentials. They live in a
dedicated vault, `Costs`:

| Item | Fields |
|---|---|
| `Copilot Money` | `refresh_token`, `api_key` |
| `Google Cloud` | `service_account_json`, `billing_table` |

`ops/copilot-token.sh` captures and verifies the Copilot values; the Google
Cloud fields start as placeholders until you paste in a billing-export service
account (see [sources.md](sources.md#google-cloud)).

The app resolves each secret through three layers, in order (`src/lib/secrets.ts`):

1. **Live 1Password** — `op read`, active only when `OP_SERVICE_ACCOUNT_TOKEN`
   and `OP_VAULT` are set in the container and `op` is on PATH. Authoritative
   when present. Enabling it needs a **scoped** service account for the `Costs`
   vault, which is an owner-only step in 1Password — see below.
2. **AES-SQLite** — what the `/sources` UI writes and where a rotated Copilot
   token is persisted. Ranks above the deploy seed so a reconnect isn't
   shadowed.
3. **Injected env** — `COSTS_SECRET_*_B64`, written to `secrets.env` on the CT
   by `deploy.sh`, which reads the vault at deploy time via the root→`sudo`
   service-account tokens on the trusted machine. This is how secrets reach the
   container **today**, with no 1Password token in the container at all.

Values are cached in-process (`COSTS_SECRET_TTL_MS`, default 5 min). A secret
provided by layer 1 or 3 can't be removed from the UI — remove it from the vault
instead.

**To enable live in-container retrieval** (optional upgrade): in 1Password,
create a service account scoped to the `Costs` vault, store its token in the
`Service Accounts` vault as `Service Account Auth Token: Costs`, add the `op` CLI
to the image, and set `OP_SERVICE_ACCOUNT_TOKEN` + `OP_VAULT=Costs` in the
container env. Until then the deploy-time seed (layer 3) is the working path and
needs no owner action.

## Backups

Back up the precious half:

```
$COSTS_DATA_DIR/config/    rules + overrides — human judgement, irreplaceable
$COSTS_DATA_DIR/raw/       uploaded exports — point-in-time, a 24h re-request
```

`costs.db` is derived and rebuildable from those. Put `config/` under git:

```bash
ssh root@proxmox 'pct exec 121 -- bash -c "cd /srv/costs/config && git init && git add -A && git commit -m init"'
```

The current deployment keeps data on the CT rootfs, so it's covered by Proxmox
container backups but not by a ZFS dataset snapshot.

## Checking on it

```bash
curl http://accounting:8000/api/health                    # {"ok":true}
ssh root@proxmox 'pct exec 121 -- docker ps'
ssh root@proxmox 'pct exec 121 -- docker logs --tail 100 costs'
ssh root@proxmox 'pct config 121 | grep -E "^(hostname|tags)"'
```

Job history and per-job logs are in the UI at `/sources`, or `GET /api/jobs`.

## Troubleshooting

**Container healthy but no new data.** Check `source_state`. The nightly sync runs
whether or not sources are connected and records `last_sync_status = error` with
the reason. Both Copilot and GCP report "is not connected" until credentials are
added on `/sources`.

**Everything on the dashboard looks invented.** It probably is. A fresh install is
seeded with 14 months of demo data. If `secrets` and `source_documents` are both
empty, nothing real has been ingested. See
[development.md](development.md#the-seed-data-is-fake).

**Build fails on `COPY /app/public`.** `public/` is empty, git can't track an empty
directory, and buildkit fails on a missing COPY source. `deploy.sh` recreates it;
any other sync path has to as well.

**Server crashes mid-query on Node 24.** better-sqlite3 11.x. The Dockerfile pins
Node 22 for this — see [development.md](development.md#traps).

**`pct exec` behaves oddly.** It runs `execvp` directly with no shell, so builtins,
globs, pipes and redirects need an explicit `bash -lc '...'`.

## Creating a fresh container

`deploy.sh` does this when no CT matches `CT_NAME`: unprivileged, `nesting=1`,
DHCP, `onboot`, tagged `apps`, Docker from the official repo. The older
`ops/proxmox/bootstrap.sh` also sets up a ZFS bind mount and Tailscale for the
tailnet-only posture, and prints the manual steps it doesn't automate.
