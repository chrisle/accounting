#!/usr/bin/env bash
# Create the LXC that runs the costs dashboard, on the Proxmox host.
#
#   scp ops/proxmox/bootstrap.sh root@proxmox:/tmp/ && ssh root@proxmox bash /tmp/bootstrap.sh
#
# Idempotent: re-running with an existing CTID is refused rather than clobbering.
set -euo pipefail

CTID="${CTID:-120}"
HOSTNAME="${HOSTNAME:-costs}"
CORES="${CORES:-2}"
MEMORY="${MEMORY:-2048}"
ROOTFS="${ROOTFS:-local-lvm:8}"
BRIDGE="${BRIDGE:-vmbr0}"
DATASET="${DATASET:-/rpool/data/costs}"
TEMPLATE="${TEMPLATE:-local:vztmpl/debian-13-standard_13.0-1_amd64.tar.zst}"

if pct status "$CTID" &>/dev/null; then
  echo "CT $CTID already exists — refusing to overwrite. Set CTID= to use another." >&2
  exit 1
fi

echo "==> Creating dataset $DATASET on the host"
mkdir -p "$DATASET"
# Unprivileged containers shift UIDs by 100000; the in-container 'costs' user
# is uid 1001, so the bind mount must be owned by 101001 on the host.
chown -R 101001:101001 "$DATASET"
chmod 700 "$DATASET"

echo "==> Creating unprivileged LXC $CTID ($HOSTNAME)"
pct create "$CTID" "$TEMPLATE" \
  --hostname "$HOSTNAME" \
  --cores "$CORES" --memory "$MEMORY" --rootfs "$ROOTFS" \
  --unprivileged 1 --features nesting=1 \
  --net0 "name=eth0,bridge=$BRIDGE,ip=dhcp" \
  --mp0 "$DATASET,mp=/srv/costs" \
  --onboot 1

pct start "$CTID"
echo "==> Waiting for network"
for _ in $(seq 1 30); do
  pct exec "$CTID" -- getent hosts deb.debian.org &>/dev/null && break
  sleep 2
done

echo "==> Installing docker + tailscale"
pct exec "$CTID" -- bash -eux <<'INNER'
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl git
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
curl -fsSL https://tailscale.com/install.sh | sh
INNER

cat <<EOF

==> LXC $CTID is up.

Remaining steps (each needs a decision or a credential, so they are not automated):

  1. Join your tailnet:
       pct exec $CTID -- tailscale up

  2. Deploy the app:
       pct exec $CTID -- git clone <your-repo-url> /opt/costs
       pct exec $CTID -- bash -c 'cd /opt/costs && \\
         echo "COSTS_ENCRYPTION_KEY=\$(openssl rand -base64 32)" > .env && \\
         docker compose up -d --build'

     Keep that .env. Losing the key means reconnecting your sources — it does
     not cost you any cost history.

  3. Expose it on the tailnet only (TLS and auth come from Tailscale):
       pct exec $CTID -- tailscale serve --bg 3000

  4. Put the config directory under git so your rules and overrides — the one
     thing nothing upstream can regenerate — get a history:
       pct exec $CTID -- bash -c 'cd /srv/costs/config && git init && git add -A && git commit -m "initial rules"'

  5. Nightly Postgres-free backup rides along with the dataset. Snapshot it:
       zfs snapshot rpool/data/costs@\$(date +%F)

Then browse to https://$HOSTNAME.<your-tailnet>.ts.net
EOF
