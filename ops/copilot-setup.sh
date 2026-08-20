#!/usr/bin/env bash
# Connect Copilot Money end to end, without the clipboard.
#
#   ops/copilot-setup.sh
#
# Prompts for the refresh token with echo off, the way a password prompt works,
# and pipes it straight into the connector. The token never reaches your
# clipboard, your shell history, or argv — so a stray terminal selection or a
# copy-on-select setting can't clobber it halfway through.
set -euo pipefail

cd "$(dirname "$0")/.."

bold() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

bold "Step 1 — get a refresh token from your browser"
cat <<'EOF'
Open https://app.copilot.money signed in, then in DevTools → Console run:

  await (async()=>{const db=await new Promise(ok=>{const r=indexedDB.open('firebaseLocalStorageDb');r.onsuccess=()=>ok(r.result)});const rows=await new Promise(ok=>{const r=db.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').getAll();r.onsuccess=()=>ok(r.result)});return rows.map(r=>r.value?.stsTokenManager?.refreshToken).find(Boolean)})()

Select the string it prints (without the surrounding quotes) and copy it.
EOF

bold "Step 2 — paste it here"
echo "Nothing will appear as you paste. Press Enter when done, Ctrl-C to abort."
printf '  token: '
# -s keeps it off the screen; -r stops backslashes being eaten.
IFS= read -rs TOKEN || true   # a paste without a trailing newline still counts
printf '\n'

[ -n "${TOKEN:-}" ] || { echo "Nothing entered." >&2; exit 1; }

bold "Step 3 — verify and sync"
# The token goes over a pipe, never argv, so `ps` can't see it. The connector
# proves it against Firebase before storing anything.
printf '%s' "$TOKEN" | npm run --silent copilot:connect
unset TOKEN

bold "Done"
echo "Open http://localhost:3000/sources — Copilot should read connected."
