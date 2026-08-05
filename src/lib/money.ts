/**
 * Money is integer cents everywhere. Never floats.
 *
 * The whole platform rests on one invariant — the allocations for a
 * transaction must sum to exactly that transaction's amount. Floating point
 * makes that invariant unenforceable, so cents it is. Convert only at render.
 */
export type Cents = number

export function toCents(v: number | string): Cents {
  const n = typeof v === 'string' ? Number(v.replace(/[$,\s]/g, '')) : v
  if (!Number.isFinite(n)) throw new Error(`not a number: ${v}`)
  // `1.005 * 100` is 100.49999999999999 in IEEE-754, which rounds to 100 and
  // quietly loses a cent. Normalising through a fixed-precision string first
  // discards the representation error before rounding.
  return Math.round(Number((n * 100).toFixed(4)))
}

export function formatCents(c: Cents, opts: { sign?: boolean } = {}): string {
  const s = (Math.abs(c) / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: Math.abs(c) >= 100_000_00 ? 0 : 2,
  })
  if (opts.sign && c > 0) return `+${s}`
  return c < 0 ? `-${s}` : s
}

/**
 * Split `total` across `weights` so the parts sum to exactly `total`.
 *
 * Largest-remainder apportionment: floor everything, then hand the leftover
 * cents to whoever got rounded down hardest. This is what keeps a proportional
 * GCP allocation from drifting a cent or two off the actual card charge.
 */
export function apportion(total: Cents, weights: number[]): Cents[] {
  const sum = weights.reduce((a, b) => a + b, 0)
  if (sum === 0) {
    // No signal to split on: put it all on the first bucket rather than lose it.
    return weights.map((_, i) => (i === 0 ? total : 0))
  }

  const exact = weights.map((w) => (total * w) / sum)
  const floors = exact.map((x) => Math.trunc(x))
  let remainder = total - floors.reduce((a, b) => a + b, 0)

  const order = exact
    .map((x, i) => ({ i, frac: Math.abs(x - Math.trunc(x)) }))
    .sort((a, b) => b.frac - a.frac)

  const step = remainder >= 0 ? 1 : -1
  for (let k = 0; remainder !== 0 && k < order.length * 2; k++) {
    floors[order[k % order.length].i] += step
    remainder -= step
  }
  return floors
}
