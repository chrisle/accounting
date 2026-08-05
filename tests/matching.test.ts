import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import { matchBySubsetSum, fuzzyLink } from '../src/lib/matching/engine'
import type { LineItem, Transaction } from '../src/db/schema'

const txn = (id: string, date: string, cents: number): Transaction =>
  ({
    id,
    date,
    amountCents: cents,
    merchantRaw: 'AMZN Mktp US',
    merchantNorm: 'amzn mktp us',
    accountId: null,
    copilotCategory: null,
    notes: null,
    pending: false,
    reversesTxnId: null,
    sourceDocId: null,
    contentHash: 'x',
    createdAt: 0,
    updatedAt: 0,
  }) as Transaction

const item = (id: string, date: string, cents: number): LineItem =>
  ({
    id,
    source: 'amazon',
    externalId: id,
    date,
    amountCents: cents,
    quantity: 1,
    description: id,
    groupKey: 'order-1',
    raw: null,
    sourceDocId: null,
  }) as LineItem

describe('subset-sum matching — Amazon charges are not Amazon orders', () => {
  test('exact single-item match is found and fully confident', () => {
    const hit = matchBySubsetSum(txn('t', '2026-03-10', -4999), [
      item('a', '2026-03-08', -4999),
      item('b', '2026-03-08', -1299),
    ])
    assert.ok(hit)
    assert.equal(hit!.items.length, 1)
    assert.equal(hit!.items[0].id, 'a')
    assert.equal(hit!.confidence, 1)
  })

  test('finds the subset that sums to a merged shipment charge', () => {
    const hit = matchBySubsetSum(txn('t', '2026-03-10', -6298), [
      item('a', '2026-03-08', -4999),
      item('b', '2026-03-08', -1299),
      item('c', '2026-03-08', -8999),
    ])
    assert.ok(hit)
    assert.deepEqual(hit!.items.map((i) => i.id).sort(), ['a', 'b'])
  })

  test('absorbs tax within tolerance', () => {
    // Items total 6298; the charge includes 8.75% sales tax -> 6849. Amazon
    // per-item totals exclude the charge's tax and shipping, which is exactly
    // why the adapter runs a 9% tolerance rather than the 6% default.
    const AMAZON_OPTS = { daysBefore: 7, daysAfter: 3, toleranceCents: 200, tolerancePct: 0.09 }
    const hit = matchBySubsetSum(
      txn('t', '2026-03-10', -6849),
      [item('a', '2026-03-08', -4999), item('b', '2026-03-08', -1299)],
      AMAZON_OPTS,
    )
    assert.ok(hit)
    assert.equal(hit!.items.length, 2)
    assert.ok(hit!.confidence < 1, 'tax-absorbed match should be less confident')
  })

  test('the 6% default is too tight for Amazon tax — the adapter must widen it', () => {
    // Guards the coupling above: if the default ever changes, this fails and
    // the adapter's explicit tolerance gets re-examined.
    const hit = matchBySubsetSum(txn('t', '2026-03-10', -6849), [
      item('a', '2026-03-08', -4999),
      item('b', '2026-03-08', -1299),
    ])
    assert.equal(hit, null)
  })

  test('ignores items outside the settlement window', () => {
    // ordered two months earlier — not this charge
    const hit = matchBySubsetSum(txn('t', '2026-03-10', -4999), [
      item('a', '2026-01-08', -4999),
    ])
    assert.equal(hit, null)
  })

  test('returns null rather than guessing when nothing fits', () => {
    const hit = matchBySubsetSum(txn('t', '2026-03-10', -4999), [
      item('a', '2026-03-09', -12345),
    ])
    assert.equal(hit, null)
  })
})

describe('fuzzyLink', () => {
  test('never assigns one line item to two charges', () => {
    const items = [item('a', '2026-03-08', -4999), item('b', '2026-03-08', -4999)]
    const proposals = fuzzyLink(
      [txn('t1', '2026-03-10', -4999), txn('t2', '2026-03-11', -4999)],
      items,
    )
    const used = proposals.map((p) => p.lineItemExternalId)
    assert.equal(new Set(used).size, used.length, 'a line item was double-counted')
  })

  test('an order split across two shipments links both charges', () => {
    const proposals = fuzzyLink(
      [txn('t1', '2026-03-10', -4999), txn('t2', '2026-03-12', -1299)],
      [item('a', '2026-03-08', -4999), item('b', '2026-03-08', -1299)],
    )
    assert.equal(proposals.length, 2)
    assert.equal(new Set(proposals.map((p) => p.txnId)).size, 2)
  })
})
