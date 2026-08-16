import assert from 'node:assert/strict'
import { test, describe, before } from 'node:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * A real Copilot sync reports an account id that isn't in `accounts` yet, and
 * `transactions.account_id` is a foreign key with `foreign_keys = ON`. Before
 * upsertAccountsFor existed this failed the whole 200-row chunk with
 * "FOREIGN KEY constraint failed", so the sync could never write a single row.
 *
 * Everything is loaded dynamically: COSTS_DATA_DIR has to be set before the
 * lazy connection in db/index.ts opens a file, or this would run against ./data.
 */
process.env.COSTS_DATA_DIR = mkdtempSync(path.join(tmpdir(), 'costs-test-'))

type Mod = {
  upsertTransactions: typeof import('../src/lib/pipeline').upsertTransactions
  db: typeof import('../src/db').db
  accounts: typeof import('../src/db').accounts
  transactions: typeof import('../src/db').transactions
  eq: typeof import('drizzle-orm').eq
}
let m: Mod

before(async () => {
  const { runMigrations } = await import('../src/db/migrate')
  const pipeline = await import('../src/lib/pipeline')
  const dbmod = await import('../src/db')
  const { eq } = await import('drizzle-orm')
  runMigrations()
  m = {
    upsertTransactions: pipeline.upsertTransactions,
    db: dbmod.db,
    accounts: dbmod.accounts,
    transactions: dbmod.transactions,
    eq,
  }
})

const txn = (id: string, accountId: string | null, account?: unknown) => [
  {
    id,
    date: '2026-08-01',
    amountCents: -2014,
    merchantRaw: 'Vercel',
    merchantNorm: 'vercel',
    accountId,
    ...(account !== undefined ? { account } : {}),
  } as Parameters<Mod['upsertTransactions']>[0][number],
]

describe('accounts are created during sync', () => {
  test('an unknown account id no longer violates the foreign key', async () => {
    await m.upsertTransactions(txn('t1', 'chase-new'), null)
    const [row] = await m.db.select().from(m.transactions).where(m.eq(m.transactions.id, 't1'))
    assert.equal(row.accountId, 'chase-new')
  })

  test('account details from the source are stored', async () => {
    await m.upsertTransactions(
      txn('t2', 'chase-united', {
        id: 'chase-united',
        name: 'Chase United Explorer',
        mask: '4471',
        institution: 'Chase',
        type: 'credit',
      }),
      null,
    )
    const [a] = await m.db.select().from(m.accounts).where(m.eq(m.accounts.id, 'chase-united'))
    assert.equal(a.name, 'Chase United Explorer')
    assert.equal(a.mask, '4471')
    assert.equal(a.institution, 'Chase')
  })

  test('an id-only row creates a stub rather than failing', async () => {
    await m.upsertTransactions(txn('t3', 'bare-id'), null)
    const [a] = await m.db.select().from(m.accounts).where(m.eq(m.accounts.id, 'bare-id'))
    assert.equal(a.name, 'bare-id')
  })

  test('a later id-only sync does not overwrite an established name', async () => {
    await m.upsertTransactions(txn('t4', 'chase-united'), null)
    const [a] = await m.db.select().from(m.accounts).where(m.eq(m.accounts.id, 'chase-united'))
    assert.equal(a.name, 'Chase United Explorer', 'stub must not clobber the real name')
    assert.equal(a.mask, '4471')
  })

  test('a null account id is still allowed', async () => {
    await m.upsertTransactions(txn('t5', null), null)
    const [row] = await m.db.select().from(m.transactions).where(m.eq(m.transactions.id, 't5'))
    assert.equal(row.accountId, null)
  })

  test('a mixed batch writes every charge', async () => {
    const batch = [
      ...txn('t6', 'acct-a', { id: 'acct-a', name: 'Account A' }),
      ...txn('t7', 'acct-b'),
      ...txn('t8', null),
    ]
    const n = await m.upsertTransactions(batch, null)
    assert.equal(n, 3)
    const rows = await m.db.select().from(m.accounts)
    const ids = rows.map((r) => r.id)
    assert.ok(ids.includes('acct-a') && ids.includes('acct-b'))
  })
})
