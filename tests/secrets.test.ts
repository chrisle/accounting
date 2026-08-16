import assert from 'node:assert/strict'
import { test, describe, before, beforeEach } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * The secret store resolves through layers, in order:
 *   live 1Password (op)  >  AES-SQLite (UI / rotation)  >  injected env seed
 * The op layer needs a real token so it isn't exercised here; the db/env layers,
 * their precedence and caching are. COSTS_DATA_DIR/ENCRYPTION_KEY must be set
 * before the lazy DB connection opens, so everything is imported dynamically.
 * Each test uses a distinct key — the throwaway db persists across tests.
 */
process.env.COSTS_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'costs-sec-'))
process.env.COSTS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64')
delete process.env.OP_SERVICE_ACCOUNT_TOKEN // keep the op layer dormant
delete process.env.OP_VAULT

type Mod = typeof import('../src/lib/secrets')
let s: Mod
const b64 = (v: string) => Buffer.from(v).toString('base64')

before(async () => {
  const { runMigrations } = await import('../src/db/migrate')
  s = await import('../src/lib/secrets')
  runMigrations()
})

beforeEach(() => {
  s._clearSecretCache()
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('COSTS_SECRET_')) delete process.env[k]
  }
})

describe('secret store layering', () => {
  test('round-trips through the AES-SQLite layer', async () => {
    await s.putSecret('k.roundtrip', 'db-token')
    assert.equal(await s.getSecret('k.roundtrip'), 'db-token')
  })

  test('a write is visible immediately, without waiting out the cache', async () => {
    await s.getSecret('k.immediate') // caches a null
    await s.putSecret('k.immediate', 'fresh')
    assert.equal(await s.getSecret('k.immediate'), 'fresh')
  })

  test('delete removes the db value', async () => {
    await s.putSecret('k.del', 'v')
    await s.deleteSecret('k.del')
    assert.equal(await s.getSecret('k.del'), null)
  })

  test('the db layer (UI / rotation) outranks the deploy env seed', async () => {
    await s.putSecret('k.prec', 'db-value')
    process.env.COSTS_SECRET_K_PREC_B64 = b64('env-value')
    s._clearSecretCache()
    assert.equal(await s.getSecret('k.prec'), 'db-value')
  })

  test('the env seed is used when the db layer is empty', async () => {
    process.env.COSTS_SECRET_K_SEEDONLY_B64 = b64('seed-value')
    s._clearSecretCache()
    assert.equal(await s.getSecret('k.seedonly'), 'seed-value')
  })

  test('base64 carries a multiline JSON blob intact', async () => {
    const json = '{\n  "type": "service_account",\n  "x": "a\\"b"\n}'
    process.env.COSTS_SECRET_GCP_SERVICE_ACCOUNT_JSON_B64 = b64(json)
    s._clearSecretCache()
    assert.equal(await s.getSecret('gcp.service_account_json'), json)
  })

  test('a plain (non-b64) env value is also accepted', async () => {
    process.env.COSTS_SECRET_GCP_BILLING_TABLE = 'proj.ds.tbl'
    s._clearSecretCache()
    assert.equal(await s.getSecret('gcp.billing_table'), 'proj.ds.tbl')
  })

  test('the cache holds a value until cleared', async () => {
    process.env.COSTS_SECRET_K_CACHE = 'first'
    assert.equal(await s.getSecret('k.cache'), 'first')
    process.env.COSTS_SECRET_K_CACHE = 'second'
    assert.equal(await s.getSecret('k.cache'), 'first', 'still cached')
    s._clearSecretCache()
    assert.equal(await s.getSecret('k.cache'), 'second')
  })
})
