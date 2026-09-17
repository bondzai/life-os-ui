/**
 * The number formats and APR provenance helpers the Opportunities board needs, and nothing else.
 *
 * Split out of `opportunities.tsx` so they can be tested directly — a page file that also exports
 * helpers loses fast refresh, which is why `radar-gauges.ts` sits beside `radar.tsx` the same way.
 *
 * All of them follow the house rule: missing is `—` or absent, never `0`. A pool whose APR we
 * cannot explain says so; it never reads as a pool with no emissions.
 */

import type { AprComponent } from './types'

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

/** vfat's component names, in the words the rest of these surfaces use. */
const COMPONENT_LABELS: Record<string, string> = {
  swapFees: 'fees',
  staking: 'staking',
  offChainRewards: 'rewards',
}

/**
 * The APR broken into what pays it — `"fees 61% · rewards 19%"`.
 *
 * Empty when the feed gave no basis, which reads as "we cannot explain this number" rather than
 * as a pool with no components. Ordered as the feed orders it: vfat lists the dominant strand
 * first, and re-sorting would lose that.
 */
export function formatAprMix(components: AprComponent[] | undefined): string {
  if (!components?.length) return ''
  return components
    .map((c) => `${COMPONENT_LABELS[c.kind] ?? c.kind} ${Math.round(c.apr).toLocaleString()}%`)
    .join(' · ')
}

/**
 * The share of the APR that stops when an emissions programme does.
 *
 * `null` when there is no basis to judge from — never `0`, which would claim the yield is all fees.
 */
export function emissionShare(components: AprComponent[] | undefined): number | null {
  if (!components?.length) return null
  const total = components.reduce((sum, c) => sum + c.apr, 0)
  if (total <= 0) return null
  const emissions = components
    .filter((c) => c.kind !== 'swapFees')
    .reduce((sum, c) => sum + c.apr, 0)
  return emissions / total
}

/**
 * A warning when a quoted window rests on less data than it claims.
 *
 * Live rows carry `feeWindowDays: 7` beside `effectiveFeeWindowDays: 1.04` — a week's APR measured
 * over a day. A tenth of a day of slack is rounding, not a caveat, so only a real shortfall speaks.
 */
export function windowCaveat(row: {
  fee_window_days?: number
  effective_fee_window_days?: number
}): string | null {
  const { fee_window_days: declared, effective_fee_window_days: effective } = row
  if (declared === undefined || effective === undefined) return null
  if (effective >= declared - 0.1) return null
  return `${declared}-day APR measured over ${effective.toFixed(1)} days`
}
