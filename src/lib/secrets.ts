import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { db, secrets } from '@/db'

/**
 * Source credentials (Copilot refresh token, GCP service-account JSON) resolved
 * from the first layer that has them, newest-source wins:
 *
 *   1. live 1Password   — `op read`, when OP_SERVICE_ACCOUNT_TOKEN + OP_VAULT
 *                         are set and the `op` CLI is on PATH. Authoritative when
 *                         present: it's the live source of truth and picks up
 *                         rotations on cache expiry. Activates once a scoped
 *                         token exists in the container.
 *   2. AES-SQLite       — sealed with COSTS_ENCRYPTION_KEY. What the /sources UI
 *                         writes, and where getIdToken persists a rotated Copilot
 *                         token. Ranks above the deploy seed so a UI reconnect or
 *                         a rotation isn't shadowed by a stale boot-time value.
 *   3. injected env     — COSTS_SECRET_<KEY>[_B64], written by deploy.sh from the
 *                         1Password vault at deploy time. Seeds a fresh container
 *                         (empty db, no token) so secrets still come from 1P today.
 *
 * A consequence worth knowing: an env- or 1Password-provided secret can't be
 * removed from the /sources UI (disconnect only clears the db copy) — remove it
 * from the vault instead. Results are cached in-process with a short TTL so a
 * sync doesn't shell out to `op` on every call; writes update the cache.
 *
 * 1Password is the source of truth in production; the vault is created and
 * seeded by ops (see ops/copilot-token.sh and deploy.sh). Losing every layer
 * just means reconnecting a source — it never costs cost history.
 */

const TTL_MS = Number(process.env.COSTS_SECRET_TTL_MS ?? 300_000)

type CacheEntry = { value: string | null; exp: number }
const cache = new Map<string, CacheEntry>()

// ------------------------------------------------------------------ AES layer

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

async function readFromDb(name: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(secrets)
    .where(eq(secrets.key, name))
    .limit(1)
  if (!row) return null
  try {
    return open(row.ciphertext)
  } catch {
    // Wrong or rotated encryption key — treat as absent rather than crashing.
    return null
  }
}

// ------------------------------------------------------------------ env layer

/** `copilot.refresh_token` -> `COSTS_SECRET_COPILOT_REFRESH_TOKEN`. */
function envKey(name: string): string {
  return 'COSTS_SECRET_' + name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')
}

/**
 * deploy.sh always base64-encodes injected values (`_B64` suffix) so a GCP
 * service-account JSON — quotes, newlines and all — survives an env file. A
 * plain form is accepted too for hand-set values.
 */
function readFromEnv(name: string): string | null {
  const k = envKey(name)
  const b64 = process.env[k + '_B64']
  if (b64) {
    try {
      return Buffer.from(b64, 'base64').toString('utf8')
    } catch {
      return null
    }
  }
  return process.env[k] ?? null
}

// ------------------------------------------------------------ 1Password layer

const OP_ITEM_TITLES: Record<string, string> = {
  copilot: 'Copilot Money',
  gcp: 'Google Cloud',
}

/** `copilot.refresh_token` -> `op://<vault>/Copilot Money/refresh_token`. */
function opRef(name: string): string | null {
  const vault = process.env.OP_VAULT
  if (!vault) return null
  const dot = name.indexOf('.')
  if (dot === -1) return `op://${vault}/${name}/credential`
  const source = name.slice(0, dot)
  const field = name.slice(dot + 1)
  return `op://${vault}/${OP_ITEM_TITLES[source] ?? source}/${field}`
}

let opWarned = false

async function readFromOp(name: string): Promise<string | null> {
  const token = process.env.OP_SERVICE_ACCOUNT_TOKEN
  const ref = opRef(name)
  if (!token || !ref) return null // not configured: never spawn a process
  try {
    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const run = promisify(execFile)
    const { stdout } = await run('op', ['read', ref, '--no-newline'], {
      env: { ...process.env, OP_SERVICE_ACCOUNT_TOKEN: token },
      timeout: 5000,
      maxBuffer: 1 << 20,
    })
    return stdout || null
  } catch (e: unknown) {
    // A missing item just falls through to the next layer. But a missing `op`
    // binary while a token IS set is a real misconfiguration — say so once.
    const msg = e instanceof Error ? e.message : String(e)
    if (!opWarned && /ENOENT|not found|command not found/i.test(msg)) {
      opWarned = true
      console.warn('[secrets] OP_SERVICE_ACCOUNT_TOKEN is set but `op` is not on PATH; using env/db layers')
    }
    return null
  }
}

// --------------------------------------------------------------------- public

export async function getSecret(name: string): Promise<string | null> {
  const hit = cache.get(name)
  if (hit && hit.exp > Date.now()) return hit.value

  let value = await readFromOp(name)
  if (value == null) value = await readFromDb(name)
  if (value == null) value = readFromEnv(name)

  cache.set(name, { value, exp: Date.now() + TTL_MS })
  return value
}

/** Write goes to the AES-SQLite layer — the only one the app owns. */
export async function putSecret(name: string, value: string): Promise<void> {
  const ciphertext = seal(value)
  await db
    .insert(secrets)
    .values({ key: name, ciphertext })
    .onConflictDoUpdate({
      target: secrets.key,
      set: { ciphertext, updatedAt: Math.floor(Date.now() / 1000) },
    })
  cache.set(name, { value, exp: Date.now() + TTL_MS })
}

export async function deleteSecret(name: string): Promise<void> {
  await db.delete(secrets).where(eq(secrets.key, name))
  // Can't unset an env- or 1Password-provided value from here; drop the cache
  // so the next read reflects whatever those layers still return.
  cache.delete(name)
}

/** Test seam: forget cached values so a changed layer is picked up at once. */
export function _clearSecretCache(): void {
  cache.clear()
}
