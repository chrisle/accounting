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
const DEFAULT_API_KEY = 'AIzaSyC1t5Z9nq4Z0Zw6xR7VqXK1r9Gk_Q0PLACEHOLDER'

let cached: { token: string; expiresAt: number } | null = null

export async function isConnected(): Promise<boolean> {
  return (await getSecret(SECRET_REFRESH)) !== null
}

export async function saveRefreshToken(
  token: string,
  apiKey?: string,
): Promise<void> {
  await putSecret(SECRET_REFRESH, token.trim())
  if (apiKey) await putSecret(SECRET_APIKEY, apiKey.trim())
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
    throw new Error(
      `Firebase token refresh failed (${res.status}). ` +
        `The refresh token is probably revoked — reconnect Copilot. ${body.slice(0, 200)}`,
    )
  }

  const json = (await res.json()) as {
    id_token: string
    refresh_token?: string
    expires_in: string
  }

  // Firebase can hand back a rotated refresh token; persist it or we lock out.
  if (json.refresh_token && json.refresh_token !== refresh) {
    await putSecret(SECRET_REFRESH, json.refresh_token)
  }

  const ttl = Number(json.expires_in || 3600)
  cached = { token: json.id_token, expiresAt: Date.now() + (ttl - 300) * 1000 }
  return cached.token
}
