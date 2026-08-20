import { getSecret } from '@/lib/secrets'

/**
 * PayPal REST auth is a plain client-credentials exchange: the app's client id
 * and secret, HTTP-basic, for a bearer token that lasts about nine hours. No
 * user consent, no refresh token, so this runs unattended once the pair is
 * stored.
 */

export const API_BASE = process.env.PAYPAL_API_BASE ?? 'https://api-m.paypal.com'

const SECRET_CLIENT = 'paypal.client_id'
const SECRET_SECRET = 'paypal.secret'

let cached: { token: string; expiresAt: number } | null = null

export async function isConnected(): Promise<boolean> {
  return (await getSecret(SECRET_CLIENT)) !== null
}

/**
 * Verifies before it stores, so a mistyped secret fails at the form rather than
 * on the first sync at 4am. Returns nothing — the caller only cares that it
 * worked.
 */
export async function verifyCredentials(clientId: string, secret: string): Promise<void> {
  await requestToken(clientId, secret)
}

export async function getAccessToken(): Promise<string> {
  if (cached && Date.now() < cached.expiresAt) return cached.token

  const clientId = await getSecret(SECRET_CLIENT)
  const secret = await getSecret(SECRET_SECRET)
  if (!clientId || !secret) {
    throw new Error('PayPal is not connected. Add API credentials in Sources.')
  }

  const { token, ttl } = await requestToken(clientId, secret)
  cached = { token, expiresAt: Date.now() + (ttl - 300) * 1000 }
  return token
}

/** Drop the cached token — used after a reconnect so a rotated secret takes. */
export function clearTokenCache(): void {
  cached = null
}

async function requestToken(
  clientId: string,
  secret: string,
): Promise<{ token: string; ttl: number }> {
  const res = await fetch(`${API_BASE}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${clientId}:${secret}`).toString('base64')}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    // PayPal answers a bad pair with 401 invalid_client, which is specific
    // enough to say plainly instead of echoing the raw body.
    throw new Error(
      /invalid_client/.test(body)
        ? 'PayPal rejected those credentials. Check the client ID and secret, and that they are for the Live app rather than Sandbox.'
        : `PayPal token request failed (${res.status}). ${body.slice(0, 200)}`,
    )
  }

  const json = (await res.json()) as { access_token: string; expires_in: number }
  return { token: json.access_token, ttl: Number(json.expires_in || 32400) }
}
