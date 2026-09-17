/**
 * The two number formats the Opportunities board needs and nothing else does.
 *
 * Split out of `opportunities.tsx` so they can be tested directly — a page file that also exports
 * helpers loses fast refresh, which is why `radar-gauges.ts` sits beside `radar.tsx` the same way.
 *
 * Both follow the house rule: missing is `—`, never `0`.
 */

/**
 * An APR as vfat reports it — percent on their scale, so `72.4` is 72.4%.
 *
 * The decimal is dropped above 1000% on purpose. These values span single digits to seven, and a
 * dust pool reading `3129115.9%` looks like a parsing bug, where `3,129,116%` reads as exactly what
 * it is: a number too silly to act on.
 */
export function formatApr(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  if (value >= 1000) return `${Math.round(value).toLocaleString()}%`
  return `${value.toFixed(1)}%`
}

/**
 * A pool fee, which the feed reports in hundredths of a basis point: `3000` is a 0.3% pool.
 *
 * Two decimals because the tiers that matter are 0.01%, 0.05%, 0.30% and 1.00%, and rounding to
 * one would collapse the first two into "0.0%".
 */
export function formatFee(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return `${(value / 10_000).toFixed(2)}%`
}
