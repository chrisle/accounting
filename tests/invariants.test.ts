import assert from 'node:assert/strict'
import { test, describe } from 'node:test'
import { apportion, toCents, formatCents } from '../src/lib/money'
import {
  assertBalanced,
  reconcile,
  InvariantViolation,
  type DraftAllocation,
} from '../src/lib/reconcile/invariants'

const draft = (amountCents: number, projectId = 'p1'): DraftAllocation => ({
  txnId: 't1',
  projectId,
  amountCents,
  basis: 'direct',
  provenance: 'rule',
})

describe('apportion', () => {
  test('parts always sum to the total, exactly', () => {
    const cases: [number, number[]][] = [
      [-10000, [1, 1, 1]], // 3-way split of a non-divisible amount
      [-33333, [7, 11, 13, 2]],
      [10000, [0.42, 0.08, 0.14, 0.11, 0.25]],
      [-1, [1, 1]],
      [-99999999, [1, 2, 3, 4, 5, 6, 7, 8, 9]],
    ]
    for (const [total, weights] of cases) {
      const parts = apportion(total, weights)
      assert.equal(
        parts.reduce((a, b) => a + b, 0),
        total,
        `apportion(${total}, [${weights}]) = [${parts}]`,
      )
    }
  })

  test('zero weights still preserve the total rather than losing it', () => {
    const parts = apportion(-5000, [0, 0, 0])
    assert.equal(parts.reduce((a, b) => a + b, 0), -5000)
  })

  test('single bucket takes everything', () => {
    assert.deepEqual(apportion(-1234, [5]), [-1234])
  })
})

describe('reconcile — the invariant the platform rests on', () => {
  test('no drafts -> one residual on __unallocated__', () => {
    const out = reconcile('t1', -5000, [])
    assert.equal(out.length, 1)
    assert.equal(out[0].projectId, '__unallocated__')
    assert.equal(out[0].amountCents, -5000)
    assertBalanced('t1', -5000, out)
  })

  test('drafts that already tie are passed through untouched', () => {
    const drafts = [draft(-3000), draft(-2000, 'p2')]
    const out = reconcile('t1', -5000, drafts)
    assert.deepEqual(out, drafts)
    assertBalanced('t1', -5000, out)
  })

  test('a metered feed within tolerance is scaled onto the real charge', () => {
    // GCP meters daily usage; the card sees a monthly invoice net of credits.
    const drafts = [draft(-6000), draft(-4000, 'p2')]
    const out = reconcile('t1', -9800, drafts) // 2% off
    assertBalanced('t1', -9800, out)
    assert.ok(out.every((o) => o.basis === 'proportional'))
    assert.ok(out.every((o) => o.scaleFactor && o.scaleFactor < 1))
    // Nothing lands in unallocated — this is rounding, not ignorance.
    assert.ok(out.every((o) => o.projectId !== '__unallocated__'))
  })

  test('a large gap books an honest residual instead of silently scaling', () => {
    const out = reconcile('t1', -20000, [draft(-5000)])
    assertBalanced('t1', -20000, out)
    const residual = out.find((o) => o.projectId === '__unallocated__')
    assert.ok(residual, 'expected a residual row')
    assert.equal(residual!.amountCents, -15000)
    assert.equal(residual!.confidence, 0)
  })

  test('an over-allocation is corrected, not left to inflate a project', () => {
    const out = reconcile('t1', -5000, [draft(-4000), draft(-4000, 'p2')])
    assertBalanced('t1', -5000, out)
  })

  test('refunds (positive amounts) reconcile the same way', () => {
    const out = reconcile('t1', 2500, [])
    assertBalanced('t1', 2500, out)
    assert.equal(out[0].amountCents, 2500)
  })

  test('assertBalanced throws loudly when something is off by a cent', () => {
    assert.throws(
      () => assertBalanced('t1', -5000, [{ amountCents: -4999 }]),
      InvariantViolation,
    )
  })
})

describe('money', () => {
  test('parses currency strings without float drift', () => {
    assert.equal(toCents('$1,234.56'), 123456)
    assert.equal(toCents('0.07'), 7)
    assert.equal(toCents(19.99), 1999)
    // The classic float trap: 0.1 + 0.2 style accumulation.
    assert.equal(toCents(1.005), 101)
  })

  test('formats with an explicit sign convention', () => {
    assert.equal(formatCents(-123456), '-$1,234.56')
    assert.equal(formatCents(123456), '$1,234.56')
  })
})
