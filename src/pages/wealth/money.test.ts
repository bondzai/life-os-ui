/**
 * The display-currency formatter.
 *
 * The case that matters most is the missing rate: showing a USD figure under a THB label
 * understates net worth about thirty-fold while looking entirely plausible, which is exactly the
 * kind of wrong a person cannot catch by eye.
 */

import { describe, expect, it } from 'vitest'
import { formatMoney, toDisplay } from './money'
import type { Rates } from './types'

const RATES: Rates = { usd: 1, thb: 32.915, btc_usd: 74_815 }

describe('toDisplay', () => {
  it('leaves USD alone and converts the others', () => {
    expect(toDisplay(100, 'usd', RATES)).toBe(100)
    expect(toDisplay(100, 'thb', RATES)).toBeCloseTo(3291.5, 4)
    expect(toDisplay(74_815, 'sats', RATES)).toBeCloseTo(100_000_000, 0)
  })

  it('returns null rather than a USD figure when the rate is missing', () => {
    expect(toDisplay(100, 'thb', null)).toBeNull()
    expect(toDisplay(100, 'thb', { usd: 1 })).toBeNull()
    expect(toDisplay(100, 'sats', { usd: 1, thb: 32.915 })).toBeNull()
    // A zero rate would divide to Infinity, which is the same poison as a null.
    expect(toDisplay(100, 'thb', { usd: 1, thb: 0 })).toBeNull()
    expect(toDisplay(100, 'sats', { usd: 1, btc_usd: 0 })).toBeNull()
  })

  it('still converts USD with no rates at all — nothing is needed for it', () => {
    expect(toDisplay(100, 'usd', null)).toBe(100)
  })
})

describe('formatMoney', () => {
  it('carries the right symbol and precision per currency', () => {
    expect(formatMoney(1234.5, 'usd', RATES)).toBe('$1,234.50')
    // Satang are noise above a thousand baht.
    expect(formatMoney(1234.5, 'thb', RATES)).toBe('฿40,634')
    expect(formatMoney(1, 'sats', RATES)).toBe('1,337 sats')
  })

  it('keeps sub-cent USD precision, which the fee tables depend on', () => {
    // "$0.02" would lose the only digits separating this row from zero.
    expect(formatMoney(0.0239, 'usd', RATES)).toBe('$0.0239')
    expect(formatMoney(0, 'usd', RATES)).toBe('$0.00')
  })

  it('shows small baht amounts to the satang', () => {
    expect(formatMoney(10, 'thb', RATES)).toBe('฿329.15')
  })

  it('abbreviates only when asked and only above 10k', () => {
    expect(formatMoney(9_999, 'usd', RATES)).toBe('$9,999.00')
    expect(formatMoney(9_999, 'usd', RATES, { compact: true })).toBe('$9,999.00')
    expect(formatMoney(12_500, 'usd', RATES, { compact: true })).toBe('$12.5k')
    expect(formatMoney(500, 'thb', RATES, { compact: true })).toBe('฿16.5k')
    expect(formatMoney(2_000_000, 'usd', RATES, { compact: true })).toBe('$2.0M')
  })

  it('renders an em dash for a missing rate, never the USD number', () => {
    expect(formatMoney(100, 'thb', null)).toBe('—')
    expect(formatMoney(100, 'sats', { usd: 1 })).toBe('—')
    // The bug this guards: 100 rendering as "฿100".
    expect(formatMoney(100, 'thb', null)).not.toContain('100')
  })

  it('treats null, undefined and non-finite as unknown rather than zero', () => {
    for (const value of [null, undefined, NaN, Infinity]) {
      expect(formatMoney(value, 'usd', RATES)).toBe('—')
    }
  })

  it('converts negatives without losing the sign', () => {
    // The sign goes outside the symbol: "$-1,234.50" reads as a currency nobody has heard of.
    expect(formatMoney(-1234.5, 'usd', RATES)).toBe('-$1,234.50')
    expect(formatMoney(-100, 'thb', RATES)).toBe('-฿3,292')
    expect(formatMoney(-1, 'sats', RATES)).toBe('-1,337 sats')
    expect(formatMoney(-50_000, 'usd', RATES, { compact: true })).toBe('-$50.0k')
  })
})
