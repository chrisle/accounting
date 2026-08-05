import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, secrets } from '@/db'

/**
 * Source credentials (Copilot refresh token, GCP service-account JSON) sealed
 * at rest with AES-256-GCM. The key never touches the database — it comes from
 * COSTS_ENCRYPTION_KEY, which lives in the compose env. Losing the key means
 * reconnecting your sources; it does not cost you any cost history.
 */

function key(): Buffer {
  const raw = process.env.COSTS_ENCRYPTION_KEY
  if (!raw) {
    throw new Error(
      'COSTS_ENCRYPTION_KEY is not set. Generate one with: openssl rand -base64 32',
    )
  }
  const k = Buffer.from(raw, 'base64')
  if (k.length !== 32) {
    throw new Error(
      `COSTS_ENCRYPTION_KEY must decode to 32 bytes, got ${k.length}`,
    )
  }
  return k
}

export function seal(plaintext: string): string {
  const iv = randomBytes(12)
  const c = createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()])
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.')
}

export function open(sealed: string): string {
  const [iv, tag, enc] = sealed.split('.').map((s) => Buffer.from(s, 'base64'))
  const d = createDecipheriv('aes-256-gcm', key(), iv)
  d.setAuthTag(tag)
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8')
}

export async function putSecret(name: string, value: string): Promise<void> {
  const ciphertext = seal(value)
  await db
    .insert(secrets)
    .values({ key: name, ciphertext })
    .onConflictDoUpdate({
      target: secrets.key,
      set: { ciphertext, updatedAt: Math.floor(Date.now() / 1000) },
    })
}

export async function getSecret(name: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(secrets)
    .where(eq(secrets.key, name))
    .limit(1)
  if (!row) return null
  try {
    return open(row.ciphertext)
  } catch {
    // Wrong or rotated key — treat as disconnected rather than crashing sync.
    return null
  }
}

export async function deleteSecret(name: string): Promise<void> {
  await db.delete(secrets).where(eq(secrets.key, name))
}
