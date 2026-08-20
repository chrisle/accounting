import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import { normalize, windows } from '../src/lib/sources/paypal/client'
import { paypalAdapter } from '../src/lib/sources/paypal'

/**
 * The two things that would silently corrupt the ledger are a sign flip and a
 * transfer counted as a cost — PayPal reports both in the same feed, and its
 * sign convention happens to already match this ledger's, unlike Copilot's.
 */

const txn = (over: Record<string, unknown> = {}) => ({
  transaction_info: {
    transaction_id: 'PP1',
    transaction_event_code: 'T0006',
    transaction_initiation_date: '2026-07-04T10:11:12-0700',
    transaction_amount: { value: '-25.00', currency_code: 'USD' },
    transaction_status: 'S',
    ...over,
  },
  payer_info: { email_address: 'shop@example.com', payer_name: { alternate_full_name: 'Some Shop' } },
})

describe('paypal windows', () => {
  test('a range inside 31 days is one request', () => {
    assert.deepEqual(windows({ start: '2026-07-01', end: '2026-07-20' }), [
      { start: '2026-07-01', end: '2026-07-20' },
    ])
  })

  test('a long range is split, contiguous and without overlap', () => {
    const w = windows({ start: '2026-01-01', end: '2026-04-15' })
    assert.ok(w.length >= 4, `expected 4+ windows, got ${w.length}`)
    assert.equal(w[0].start, '2026-01-01')
    assert.equal(w.at(-1)!.end, '2026-04-15')
    for (let i = 1; i < w.length; i++) {
      const prevEnd = new Date(`${w[i - 1].end}T00:00:00Z`)
      const thisStart = new Date(`${w[i].start}T00:00:00Z`)
      assert.equal(
        (thisStart.getTime() - prevEnd.getTime()) / 86_400_000,
        1,
        `window ${i} should start the day after the previous ended`,
      )
      const span = (new Date(`${w[i].end}T00:00:00Z`).getTime() - thisStart.getTime()) / 86_400_000
      assert.ok(span < 31, `window ${i} spans ${span} days, over PayPal's limit`)
    }
  })
})

describe('paypal normalize', () => {
  test('money out stays negative — the sign is not flipped', () => {
    assert.equal(normalize(txn())!.amountCents, -2500)
  })

  test('the fee is folded in, since the card is charged the total', () => {
    const n = normalize(txn({ fee_amount: { value: '-1.05' } }))!
    assert.equal(n.amountCents, -2605)
  })

  test('money in stays positive', () => {
    assert.equal(normalize(txn({ transaction_amount: { value: '40.00' } }))!.amountCents, 4000)
  })

  test('bank funding and withdrawals are dropped, not counted twice', () => {
    assert.equal(normalize(txn({ transaction_event_code: 'T0300' })), null)
    assert.equal(normalize(txn({ transaction_event_code: 'T0400' })), null)
    assert.ok(normalize(txn({ transaction_event_code: 'T0006' })))
  })

  test('a denied payment is not a cost', () => {
    assert.equal(normalize(txn({ transaction_status: 'D' })), null)
    assert.ok(normalize(txn({ transaction_status: 'P' })))
  })

  test('a row with no id or no amount is skipped rather than half-written', () => {
    assert.equal(normalize(txn({ transaction_id: undefined })), null)
    assert.equal(normalize(txn({ transaction_amount: undefined })), null)
  })

  test('item names beat the payer name as a description', () => {
    const withCart = { ...txn(), cart_info: { item_details: [{ item_name: 'USB-C cable' }] } }
    assert.equal(normalize(withCart)!.description, 'USB-C cable')
    assert.equal(normalize(txn())!.description, 'Some Shop')
  })

  test('the date is the initiation day, not the API timestamp', () => {
    assert.equal(normalize(txn())!.date, '2026-07-04')
  })
})

describe('paypal adapter', () => {
  const asTxn = (merchantRaw: string) =>
    ({ merchantRaw, merchantNorm: merchantRaw.toLowerCase() }) as never

  test('claims the charges that reach the card as PayPal', () => {
    assert.equal(paypalAdapter.claims(asTxn('PAYPAL *SOMESHOP')), true)
    assert.equal(paypalAdapter.claims(asTxn('PP*GUMROAD')), true)
    assert.equal(paypalAdapter.claims(asTxn('TRADER JOE S')), false)
  })
})
