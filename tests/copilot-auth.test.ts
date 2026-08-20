import assert from 'node:assert/strict'
import { test, describe, before, beforeEach } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Connecting Copilot used to seal whatever was pasted and only discover it was
 * bad on the first sync — the Sources card read "connected" while every sync
 * failed. saveRefreshToken now proves the token against Firebase first, so
 * these tests pin: nothing is stored on rejection, and a token rotated during
 * the verifying exchange is what gets stored.
 */
process.env.COSTS_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'costs-auth-'))
process.env.COSTS_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64')
delete process.env.OP_SERVICE_ACCOUNT_TOKEN
delete process.env.OP_VAULT

let auth: typeof import('../src/lib/sources/copilot/auth')
let secrets: typeof import('../src/lib/secrets')
const realFetch = globalThis.fetch

before(async () => {
  const { runMigrations } = await import('../src/db/migrate')
  runMigrations()
  auth = await import('../src/lib/sources/copilot/auth')
  secrets = await import('../src/lib/secrets')
})

beforeEach(async () => {
  globalThis.fetch = realFetch
  await auth.disconnect()
  secrets._clearSecretCache()
})

/** Stand in for securetoken.googleapis.com and record what it was sent. */
function stubFirebase(res: { status: number; body: unknown }) {
  const seen: { url: string; body: string }[] = []
  globalThis.fetch = (async (url: unknown, init: { body?: unknown }) => {
    seen.push({ url: String(url), body: String(init?.body ?? '') })
    return new Response(JSON.stringify(res.body), { status: res.status })
  }) as typeof fetch
  return seen
}

describe('connecting Copilot', () => {
  test('a rejected token is not stored', async () => {
    stubFirebase({
      status: 400,
      body: { error: { code: 400, message: 'INVALID_REFRESH_TOKEN' } },
    })

    await assert.rejects(
      () => auth.saveRefreshToken('not-a-real-token'),
      /INVALID_REFRESH_TOKEN/,
    )
    assert.equal(await secrets.getSecret('copilot.refresh_token'), null)
    assert.equal(await auth.isConnected(), false)
  })

  test('a bad API key says so instead of blaming the token', async () => {
    stubFirebase({
      status: 400,
      body: { error: { code: 400, message: 'API_KEY_INVALID' } },
    })

    await assert.rejects(
      () => auth.saveRefreshToken('x'.repeat(60), 'AIzaSyBogus'),
      /API key/,
    )
  })

  test('an accepted token is stored, along with a custom API key', async () => {
    const seen = stubFirebase({
      status: 200,
      body: { id_token: 'ID', expires_in: '3600' },
    })

    await auth.saveRefreshToken('  good-token  ', 'AIzaSyCustom')

    assert.equal(await secrets.getSecret('copilot.refresh_token'), 'good-token')
    assert.equal(await secrets.getSecret('copilot.api_key'), 'AIzaSyCustom')
    assert.equal(await auth.isConnected(), true)
    assert.match(seen[0].url, /key=AIzaSyCustom/)
    assert.match(seen[0].body, /refresh_token=good-token/)
  })

  test('a token rotated during the check is the one stored', async () => {
    stubFirebase({
      status: 200,
      body: { id_token: 'ID', refresh_token: 'rotated', expires_in: '3600' },
    })

    await auth.saveRefreshToken('original')
    assert.equal(await secrets.getSecret('copilot.refresh_token'), 'rotated')
  })

  test('with no key given, the built-in one is used and it is not the placeholder', async () => {
    const seen = stubFirebase({
      status: 200,
      body: { id_token: 'ID', expires_in: '3600' },
    })

    await auth.saveRefreshToken('y'.repeat(60))

    const key = /key=([^&]+)/.exec(seen[0].url)?.[1] ?? ''
    assert.match(key, /^AIzaSy[A-Za-z0-9_-]{33}$/)
    assert.doesNotMatch(key, /PLACEHOLDER/)
  })
})
