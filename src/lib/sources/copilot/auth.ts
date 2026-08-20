import { getSecret, putSecret, deleteSecret } from '@/lib/secrets'

/**
 * Copilot Money runs on Firebase Auth. Two facts make headless operation work:
 *
 *  1. Firebase refresh tokens are long-lived — they survive until revoked or
 *     the password changes. Capture one once, sync forever.
 *  2. Exchanging it for a 1-hour ID token is a plain POST to Google's public
 *     securetoken endpoint. No browser, no Playwright, no Rust CLI.
 *
 * The unofficial GraphQL API this then calls is not sanctioned by Copilot;
 * their own community tooling carries a terms-of-service caveat. That's the
 * cost of running unattended on a box with no macOS app to read from.
 */

const SECRET_REFRESH = 'copilot.refresh_token'
const SECRET_APIKEY = 'copilot.api_key'

// Firebase Web API key for the Copilot production project. Public by design —
// it identifies the app, it does not authorise anything on its own.
const DEFAULT_API_KEY = 'AIzaSyAMgjkeOSkHj4J4rlswOkD16N3WQOoNPpk'

let cached: { token: string; expiresAt: number } | null = null

type Exchange = { idToken: string; refreshToken?: string; ttl: number }

/**
 * The bare securetoken call. Split out from getIdToken so a token can be proven
 * live *before* it is stored — a rejected paste that gets sealed anyway leaves
 * the source reading "connected" with a credential that can never sync.
 */
export async function exchangeRefreshToken(
  refresh: string,
  apiKey: string = DEFAULT_API_KEY,
): Promise<Exchange> {
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
      }),
    },
  )

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    const code = /"message":\s*"([A-Z_]+)"/.exec(body)?.[1]
    throw new Error(
      code === 'API_KEY_INVALID'
        ? 'Firebase rejected the API key. Re-extract it with ops/copilot-token.sh.'
        : `Firebase token refresh failed (${res.status}${code ? `: ${code}` : ''}). ` +
          'The refresh token is probably revoked or mistyped — reconnect Copilot.',
    )
  }

  const json = (await res.json()) as {
    id_token: string
    refresh_token?: string
    expires_in: string
  }
  return {
    idToken: json.id_token,
    refreshToken: json.refresh_token,
    ttl: Number(json.expires_in || 3600),
  }
}

export async function isConnected(): Promise<boolean> {
  return (await getSecret(SECRET_REFRESH)) !== null
}

/**
 * Verifies before it stores. Firebase is the only thing that can tell a good
 * refresh token from a bad paste, and asking costs one request.
 */
export async function saveRefreshToken(
  token: string,
  apiKey?: string,
): Promise<void> {
  const trimmed = token.trim()
  const key = apiKey?.trim()
  const { refreshToken } = await exchangeRefreshToken(trimmed, key || DEFAULT_API_KEY)

  // Firebase may hand back a rotated token on this very exchange; store that
  // one rather than the paste, or the next sync starts from a spent token.
  await putSecret(SECRET_REFRESH, refreshToken || trimmed)
  if (key) await putSecret(SECRET_APIKEY, key)
  cached = null
}

export async function disconnect(): Promise<void> {
  await deleteSecret(SECRET_REFRESH)
  await deleteSecret(SECRET_APIKEY)
  cached = null
}

/** Exchange the refresh token for an ID token, cached until ~5 min before expiry. */
export async function getIdToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token

  const refresh = await getSecret(SECRET_REFRESH)
  if (!refresh) {
    throw new Error('Copilot is not connected. Add a refresh token in Sources.')
  }
  const apiKey = (await getSecret(SECRET_APIKEY)) ?? DEFAULT_API_KEY

  const { idToken, refreshToken, ttl } = await exchangeRefreshToken(refresh, apiKey)

  // Firebase can hand back a rotated refresh token; persist it or we lock out.
  if (refreshToken && refreshToken !== refresh) {
    await putSecret(SECRET_REFRESH, refreshToken)
  }

  cached = { token: idToken, expiresAt: Date.now() + (ttl - 300) * 1000 }
  return idToken
}
