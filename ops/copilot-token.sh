#!/usr/bin/env bash
# Get (and verify) the two credentials the Copilot adapter needs.
#
#   ops/copilot-token.sh                  # extract + verify the Firebase API key
#   ops/copilot-token.sh <refresh-token>  # also verify the token end to end
#   ops/copilot-token.sh <refresh-token> --introspect > schema.json
#
# The API key is public by design — it identifies the Firebase app and
# authorises nothing on its own — so it is scraped from the published bundle.
# The refresh token is a real credential and only ever comes from your own
# logged-in browser; this script never tries to log in for you.
set -euo pipefail

APP="${COPILOT_APP_URL:-https://app.copilot.money}"
GQL="${COPILOT_GRAPHQL_URL:-https://app.copilot.money/api/graphql}"
REFRESH="${1:-${COPILOT_REFRESH_TOKEN:-}}"
[ "${REFRESH:-}" = "--introspect" ] && REFRESH=""

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

# ---------------------------------------------------------------- the API key
# The bundle filename is content-hashed and changes on every Copilot deploy, so
# find it from the app shell rather than hard-coding it.
say "Locating the app bundle"
SHELL_HTML="$(curl -fsS -m 30 "$APP/")"
BUNDLE="$(grep -oE 'src="[^"]+\.js"' <<<"$SHELL_HTML" | sed 's/src="//;s/"//' | grep -v '^https\?://' | head -1)"
[ -n "$BUNDLE" ] || { echo "No first-party bundle found in $APP/ — the app shell changed." >&2; exit 1; }
echo "    $BUNDLE"

say "Extracting the Firebase Web API key"
KEY="$(curl -fsS -m 60 "$APP$BUNDLE" | grep -oE 'AIzaSy[A-Za-z0-9_-]{33}' | sort -u | head -1)"
[ -n "$KEY" ] || { echo "No Firebase key in the bundle. Copilot may have moved it server-side." >&2; exit 1; }
echo "    $KEY"

# A valid key rejects a bogus token with INVALID_REFRESH_TOKEN; an invalid key
# fails earlier with API_KEY_INVALID. That difference is the whole test.
say "Verifying the key"
# No -f: a 400 with a JSON error body is exactly what we want to read here.
PROBE="$(curl -sS -m 15 -X POST "https://securetoken.googleapis.com/v1/token?key=$KEY" \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=refresh_token&refresh_token=probe' || true)"
case "$PROBE" in
  *API_KEY_INVALID*) echo "    REJECTED — this key is not valid." >&2; exit 1 ;;
  *INVALID_REFRESH_TOKEN*) echo "    valid (rejected the probe token, not the key)" ;;
  *) echo "    unexpected response: $(head -c 200 <<<"$PROBE")" >&2 ;;
esac

# ----------------------------------------------------------- the refresh token
if [ -z "$REFRESH" ]; then
  cat <<EOF

$(printf '\033[1m==> Now get the refresh token\033[0m')

Firebase keeps it in IndexedDB in the browser you are logged in with. Open
$APP, sign in, then paste this into the DevTools console:

-------------------------------------------------------------------------------
(async () => {
  const found = []
  // The SDK picks a persistence backend by availability, so check both.
  for (const k of Object.keys(localStorage)) {
    if (!k.startsWith('firebase:authUser:')) continue
    try { found.push([k, JSON.parse(localStorage[k])]) } catch {}
  }
  try {
    const db = await new Promise((ok, no) => {
      const r = indexedDB.open('firebaseLocalStorageDb')
      r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error)
    })
    const rows = await new Promise((ok, no) => {
      const r = db.transaction('firebaseLocalStorage').objectStore('firebaseLocalStorage').getAll()
      r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error)
    })
    for (const row of rows) found.push([row.fbase_key, row.value])
  } catch (e) { console.warn('no IndexedDB auth record:', e.message) }

  for (const [key, v] of found) {
    const t = v && v.stsTokenManager
    if (!t || !t.refreshToken) continue
    console.log(JSON.stringify({
      email: v.email,
      apiKey: String(key || '').split(':')[2],
      refreshToken: t.refreshToken,
    }, null, 2))
  }
  if (!found.length) console.warn('Nothing found — are you signed in on this exact origin?')
})()
-------------------------------------------------------------------------------

Then verify it before pasting it into the app:

    ops/copilot-token.sh <refresh-token>

The token is long-lived — it survives until you change your password or
explicitly revoke sessions — so this is a once-per-rotation job, not a daily one.
Treat it like a password: it grants full read access to your Copilot account.

EOF
  exit 0
fi

say "Exchanging the refresh token for an ID token"
RESP="$(curl -sS -m 20 -X POST "https://securetoken.googleapis.com/v1/token?key=$KEY" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=refresh_token' \
  --data-urlencode "refresh_token=$REFRESH" || true)"

ID_TOKEN="$(python3 -c 'import sys,json; print(json.load(sys.stdin).get("id_token",""))' <<<"$RESP" 2>/dev/null || true)"
if [ -z "$ID_TOKEN" ]; then
  echo "    FAILED: $(head -c 300 <<<"$RESP")" >&2
  echo "    A revoked or mistyped token looks like this. Re-capture it." >&2
  exit 1
fi
echo "    got an ID token (${#ID_TOKEN} chars)"

# Firebase rotates refresh tokens; if it handed back a new one, that is the one
# to store. The adapter persists this automatically, but say so here too.
NEW="$(python3 -c 'import sys,json; print(json.load(sys.stdin).get("refresh_token",""))' <<<"$RESP" 2>/dev/null || true)"
if [ -n "$NEW" ] && [ "$NEW" != "$REFRESH" ]; then
  echo "    note: Firebase rotated the refresh token — store this one instead:"
  echo "    $NEW"
fi

say "Calling the Copilot API with it"
if [ "${2:-}" = "--introspect" ]; then
  curl -sS -m 60 "$GQL" -H "authorization: Bearer $ID_TOKEN" -H 'content-type: application/json' \
    -d '{"query":"{ __schema { queryType { name } types { name kind fields { name type { name kind ofType { name } } } } } }"}'
  exit 0
fi

OUT="$(curl -s -m 30 -o /dev/stdout -w '\n__HTTP__%{http_code}' "$GQL" \
  -H "authorization: Bearer $ID_TOKEN" -H 'content-type: application/json' \
  -d '{"query":"{ __typename }"}')"
CODE="${OUT##*__HTTP__}"
BODY="${OUT%__HTTP__*}"
echo "    HTTP $CODE"
echo "    $(head -c 300 <<<"$BODY")"

case "$CODE" in
  200) cat <<EOF

$(printf '\033[1m==> Working.\033[0m') Paste both of these into /sources:

    Web API key:   $KEY
    Refresh token: ${NEW:-$REFRESH}

Dump the real schema to correct the inferred query in
src/lib/sources/copilot/client.ts:

    ops/copilot-token.sh <refresh-token> --introspect > copilot-schema.json
EOF
    ;;
  401|403) echo "
    Authenticated with Firebase but Copilot rejected the token. The account may
    not have API access, or the endpoint has moved." >&2; exit 1 ;;
  *) echo "
    Unexpected. The endpoint may have changed shape." >&2; exit 1 ;;
esac
