#!/usr/bin/env bash
# Deploy the costs dashboard to the Proxmox LXC named "accounting", tagged "apps".
#
#   ops/proxmox/deploy.sh
#
# Runs from the Mac, inside a checkout. Everything goes through `ssh root@proxmox`
# and `pct exec`, so the container needs no inbound ssh, no git remote and no
# rsync (it has none).
#
# Idempotent, and safe to re-run:
#   - finds the CT by hostname rather than a hard-coded id
#   - creates it only if missing, then installs docker
#   - never touches $DATA_DIR (the SQLite db, raw uploads and config YAML)
#   - never regenerates .env once it exists — losing COSTS_ENCRYPTION_KEY means
#     reconnecting every source
set -euo pipefail

PVE_HOST="${PVE_HOST:-root@proxmox}"
CT_NAME="${CT_NAME:-accounting}"
CT_TAG="${CT_TAG:-apps}"
PORT="${PORT:-8000}"          # LAN port -> container's 3000
APP_DIR="${APP_DIR:-/opt/costs}"
DATA_DIR="${DATA_DIR:-/srv/costs}"

# Housekeeping. The CT has a 10G rootfs and each deploy leaves an untagged
# image plus ~270MB of new build cache, so without this it fills up.
#
# The cache is capped by SIZE rather than age on purpose: an age filter keeps
# everything from the last N days, so a day of frequent deploys still fills the
# disk. A size cap is bounded no matter how often this runs, and keeps the most
# recently used layers so rebuilds stay fast.
MAX_CACHE="${MAX_CACHE:-1GB}"      # ceiling for docker build cache
MIN_FREE_MB="${MIN_FREE_MB:-3000}" # below this, prune hard *before* building

# Secrets. 1Password is the source of truth (vault below); this script pulls
# them at deploy time and injects them as env into the container. Runs on the
# trusted machine that has OP_SERVICE_ACCOUNT_TOKEN_ROOT — no 1Password token
# ever enters the container. If the root token is absent, the existing
# secrets.env is left untouched.
OP_VAULT="${OP_VAULT:-Costs}"
# Keys mirror src/lib/secrets.ts (OP_ITEM_TITLES + envKey). "<env-key> <op ref>".
OP_SECRET_MAP="\
COSTS_SECRET_COPILOT_REFRESH_TOKEN|Copilot Money/refresh_token
COSTS_SECRET_COPILOT_API_KEY|Copilot Money/api_key
COSTS_SECRET_GCP_SERVICE_ACCOUNT_JSON|Google Cloud/service_account_json
COSTS_SECRET_GCP_BILLING_TABLE|Google Cloud/billing_table"

# Used only when the container does not exist yet.
NEW_CTID="${NEW_CTID:-121}"
CORES="${CORES:-2}"
MEMORY="${MEMORY:-4096}"
ROOTFS="${ROOTFS:-local-lvm:10}"
BRIDGE="${BRIDGE:-vmbr0}"
TEMPLATE="${TEMPLATE:-local:vztmpl/debian-13-standard_13.1-1_amd64.tar.zst}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
pve() { ssh -o ConnectTimeout=10 "$PVE_HOST" "$@"; }

# ---------------------------------------------------------------- locate the CT
say "Locating LXC \"$CT_NAME\" on $PVE_HOST"
CTID="$(pve "for id in \$(pct list | awk 'NR>1{print \$1}'); do
  [ \"\$(pct config \$id | awk -F': ' '/^hostname/{print \$2}')\" = '$CT_NAME' ] && echo \$id
done" | head -1)"

if [ -z "$CTID" ]; then
  CTID="$NEW_CTID"
  say "No such container — creating CT $CTID ($CT_NAME)"
  pve "pct status $CTID &>/dev/null" \
    && { echo "CT $CTID exists under another hostname. Set NEW_CTID=." >&2; exit 1; }

  pve "pct create $CTID '$TEMPLATE' \
        --hostname '$CT_NAME' \
        --cores $CORES --memory $MEMORY --rootfs '$ROOTFS' \
        --unprivileged 1 --features nesting=1 \
        --net0 'name=eth0,bridge=$BRIDGE,ip=dhcp,firewall=1' \
        --tags '$CT_TAG' --onboot 1
      pct start $CTID
      for _ in \$(seq 1 30); do
        pct exec $CTID -- getent hosts deb.debian.org &>/dev/null && break
        sleep 2
      done"
else
  say "Found CT $CTID"
fi

# ------------------------------------------------------------------- the tag
# App containers on this host carry exactly one tag. Set it unconditionally so a
# CT that predates this script (121 was tagged accounting;infrastructure) converges.
CURRENT_TAGS="$(pve "pct config $CTID | awk -F': ' '/^tags/{print \$2}'" || true)"
if [ "$CURRENT_TAGS" != "$CT_TAG" ]; then
  say "Tag: ${CURRENT_TAGS:-<none>} -> $CT_TAG"
  pve "pct set $CTID --tags '$CT_TAG'"
fi

pve "pct status $CTID | grep -q running || pct start $CTID"

# ---------------------------------------------------------------- prerequisites
say "Checking docker inside CT $CTID"
# `pct exec` execvp's directly with no shell, so `command -v` (a builtin) is not
# a thing it can run — hence the explicit bash.
if ! pve "pct exec $CTID -- bash -lc 'command -v docker'" >/dev/null 2>&1; then
  say "Installing docker"
  pve "pct exec $CTID -- bash -eux" <<'INNER'
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
INNER
fi

# --------------------------------------------------------------- data + secrets
say "Ensuring $APP_DIR and $DATA_DIR"
# The container image runs as uid 1001; on an unprivileged CT that is 1001 as
# seen from inside, which is what the bind mount needs to be owned by.
pve "pct exec $CTID -- bash -eu -c '
  mkdir -p \"$APP_DIR\" \"$DATA_DIR\"
  chown 1001:1001 \"$DATA_DIR\"
  chmod 700 \"$DATA_DIR\"
  if [ ! -f \"$APP_DIR/.env\" ]; then
    echo \"generating a fresh COSTS_ENCRYPTION_KEY\"
    {
      echo \"COSTS_ENCRYPTION_KEY=\$(openssl rand -base64 32)\"
      echo \"COSTS_TZ=America/Los_Angeles\"
      echo \"COSTS_SYNC_AT=04:15\"
    } > \"$APP_DIR/.env\"
    chmod 600 \"$APP_DIR/.env\"
  fi
  # env_file target for 1Password-sourced secrets; must exist so compose can
  # reference it even on a deploy where we do not refresh it.
  touch \"$APP_DIR/secrets.env\" && chmod 600 \"$APP_DIR/secrets.env\"'"

# ---------------------------------------------------------------- secrets (1P)
# Read each declared secret from the 1Password vault via the two-hop root->sudo
# pattern (the trusted machine has the root token) and write a base64 env file
# on the CT. base64 so a multiline GCP service-account JSON survives an env file.
# Values are never printed. Placeholders (unfilled GCP fields) are skipped.
if [ -n "${OP_SERVICE_ACCOUNT_TOKEN_ROOT:-}" ] && command -v op >/dev/null 2>&1; then
  say "Syncing secrets from 1Password vault \"$OP_VAULT\""
  SUDO_TOKEN="$(OP_SERVICE_ACCOUNT_TOKEN="$OP_SERVICE_ACCOUNT_TOKEN_ROOT" \
    op item get "Service Account Auth Token: sudo" --vault "Service Accounts" \
    --fields credential --reveal 2>/dev/null || true)"
  if [ -z "$SUDO_TOKEN" ]; then
    echo "    could not read the sudo child token — skipping secret sync"
  else
    tmp="$(mktemp)"
    n=0; skipped=0
    while IFS='|' read -r envk ref; do
      [ -n "$envk" ] || continue
      val="$(OP_SERVICE_ACCOUNT_TOKEN="$SUDO_TOKEN" op read "op://$OP_VAULT/$ref" --no-newline 2>/dev/null || true)"
      case "$val" in
        ''|PLACEHOLDER*) skipped=$((skipped+1)); continue ;;
      esac
      printf '%s_B64=%s\n' "$envk" "$(printf '%s' "$val" | base64 | tr -d '\n')" >> "$tmp"
      n=$((n+1))
    done <<EOF
$OP_SECRET_MAP
EOF
    # Only overwrite when we actually retrieved something, so a transient 1P
    # failure can't wipe a previously-synced secrets.env.
    if [ "$n" -gt 0 ]; then
      pve "pct exec $CTID -- bash -c 'cat > $APP_DIR/secrets.env && chmod 600 $APP_DIR/secrets.env'" < "$tmp"
      echo "    synced $n secret(s), skipped $skipped placeholder(s)"
    else
      echo "    nothing to sync ($skipped placeholder(s)) — leaving secrets.env as-is"
    fi
    rm -f "$tmp"
  fi
else
  say "Skipping 1Password sync (no root token or op CLI); using existing secrets.env"
fi

# The base compose.yaml binds 127.0.0.1 only, on the assumption that
# `tailscale serve` fronts it. This deployment is reached directly over the LAN,
# so the override replaces (not extends) the port mapping.
say "Writing compose.override.yaml (0.0.0.0:$PORT -> 3000)"
pve "pct exec $CTID -- tee $APP_DIR/compose.override.yaml >/dev/null" <<EOF
# Generated by ops/proxmox/deploy.sh — edits here are overwritten on deploy.
# Plain HTTP on the LAN at http://$CT_NAME:$PORT. No TLS, no auth in front of it.
services:
  costs:
    ports: !override
      - "0.0.0.0:$PORT:3000"
    # 1Password-sourced secrets, refreshed each deploy (COSTS_SECRET_*_B64).
    env_file:
      - secrets.env
EOF

# -------------------------------------------------------------------- the source
# git ls-files, so the working tree ships exactly as committed-or-modified and
# node_modules/.next/.env.local stay out. Directories are cleared first so files
# deleted since the last deploy do not linger.
say "Pushing source to $APP_DIR"
git ls-files -z | tar --null -czf - -T - \
  | pve "pct exec $CTID -- bash -eu -c '
      rm -rf \"$APP_DIR/src\" \"$APP_DIR/ops\" \"$APP_DIR/tests\" \"$APP_DIR/public\"
      tar xzf - -C \"$APP_DIR\"
      # public/ is empty in this repo and git cannot carry an empty directory,
      # so nothing in the tar recreates it — but the Dockerfile COPYs it and
      # buildkit fails hard on a missing source path.
      mkdir -p \"$APP_DIR/public\"'"

# ------------------------------------------------------------------------ build
# A build needs room for a whole new image before the old one can be released.
# Checking first turns "no space left on device" halfway through into a prune.
say "Checking free space"
pve "pct exec $CTID -- env MIN_FREE_MB='$MIN_FREE_MB' bash -s" <<'INNER'
set -eu
free_mb() { df --output=avail -m / | tail -1 | tr -d ' '; }
avail=$(free_mb)
echo "    ${avail} MB free"
if [ "$avail" -lt "$MIN_FREE_MB" ]; then
  echo "    below ${MIN_FREE_MB} MB — pruning before the build"
  docker image prune -f >/dev/null 2>&1 || true
  docker builder prune -af >/dev/null 2>&1 || true
  apt-get clean >/dev/null 2>&1 || true
  echo "    now $(free_mb) MB free"
fi
INNER

say "Building and starting"
pve "pct exec $CTID -- bash -eu -c '
  cd \"$APP_DIR\" && docker compose up -d --build --remove-orphans'"

# ----------------------------------------------------------------------- verify
say "Waiting for health"
pve "pct exec $CTID -- bash -eu -c '
  for i in \$(seq 1 60); do
    if curl -fsS -m 3 http://127.0.0.1:$PORT/api/health >/dev/null 2>&1; then
      echo \"healthy after \${i}s\"; exit 0
    fi
    sleep 1
  done
  echo \"never became healthy — recent logs:\" >&2
  docker compose -f \"$APP_DIR/compose.yaml\" -f \"$APP_DIR/compose.override.yaml\" logs --tail 40 >&2
  exit 1'"

# Only after the new image is healthy — pruning earlier could delete the image
# we would need to fall back to.
say "Reclaiming disk"
pve "pct exec $CTID -- env MAX_CACHE='$MAX_CACHE' bash -s" <<'INNER'
set -eu
free_mb() { df --output=avail -m / | tail -1 | tr -d ' '; }
before=$(free_mb)
# The previous deploy's image is now untagged; the running one is not touched.
docker image prune -f >/dev/null 2>&1 || true
docker container prune -f >/dev/null 2>&1 || true
# --max-used-space needs Docker 23+; fall back to dropping the cache entirely
# rather than silently leaving it to grow.
docker builder prune -f --max-used-space "$MAX_CACHE" >/dev/null 2>&1 \
  || docker builder prune -af >/dev/null 2>&1 || true
# Left behind by the docker install, and by any apt use since.
apt-get clean >/dev/null 2>&1 || true
after=$(free_mb)
echo "    reclaimed $((after - before)) MB"
cache=$(docker system df --format '{{if eq .Type "Build Cache"}}{{.Size}}{{end}}' 2>/dev/null | tr -d '\n')
echo "    build cache now ${cache:-unknown} (cap ${MAX_CACHE})"
df -h / | awk 'NR==2 {print "    " $4 " free of " $2 " (" $5 " used)"}'
INNER

IP="$(pve "pct exec $CTID -- hostname -I | awk '{print \$1}'" | tr -d '\r')"
say "Deployed"
cat <<EOF

  CT $CTID  $CT_NAME  tags=$CT_TAG  $IP

  http://$CT_NAME:$PORT     (or http://$IP:$PORT)

  Not exposed beyond the LAN, and there is no auth in front of it. The data in
  $DATA_DIR was left untouched; $APP_DIR/.env holds the encryption key and is
  backed up nowhere else.
EOF
