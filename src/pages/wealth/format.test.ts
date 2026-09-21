/**
 * Tests for the wealth formatters.
 *
 * Concentrated on `formatAmount`'s small end, which is where it was getting things wrong: token
 * balances routinely land below 0.0001, and every one of them used to render in scientific
 * notation.
 */

import { describe, expect, it } from 'vitest'
import { collapseZeros, formatAmount } from './format'

describe('formatAmount', () => {
  it('never uses scientific notation', () => {
    // Real balances off the claimable panel — the top row by value was the worst-rendered one.
    expect(formatAmount(9.06e-6)).toBe('0.0₅906')
    expect(formatAmount(1.47e-6)).toBe('0.0₅147')
    expect(formatAmount(7.5e-7)).toBe('0.0₆75')
    expect(formatAmount(2.46e-5)).toBe('0.0₄246')

    for (const n of [1e-4, 1e-5, 1e-6, 1e-7, 1e-8, 1e-9, 3.3e-7, 9.99e-5]) {
      expect(formatAmount(n)).not.toMatch(/e/i)
    }
  })

  it('keeps three significant figures and trims the padding', () => {
    expect(formatAmount(1.23456e-5)).toBe('0.0₄123')
    expect(formatAmount(1e-6)).toBe('0.0₅1')
    expect(formatAmount(-9.06e-6)).toBe('-0.0₅906')
  })

  it('gives a bound rather than a screenful of zeros', () => {
    // Past ten places the digits say nothing a reader can use, and the USD column beside them is
    // what carries the meaning at that size.
    expect(formatAmount(1e-11)).toBe('<0.0000000001')
    expect(formatAmount(-1e-11)).toBe('>−0.0000000001')
  })

  it('leaves the ordinary sizes alone', () => {
    expect(formatAmount(0)).toBe('0')
    expect(formatAmount(0.000156)).toBe('0.000156')
    expect(formatAmount(0.008108)).toBe('0.008108')
    expect(formatAmount(1)).toBe('1')
    expect(formatAmount(1234.5678)).toBe('1,234.5678')
    expect(formatAmount(2_500_000)).toBe('2.5M')
  })

  it('collapses only runs long enough to be worth counting', () => {
    // The zeros are the problem: 0.00000906 and 0.0000906 differ by a factor of ten and by one
    // character, in the middle of a run nobody counts. Below three zeros the plain form is no
    // longer, so switching notation would be change for its own sake.
    expect(collapseZeros('0.00156')).toBe('0.00156')
    expect(collapseZeros('0.000156')).toBe('0.0₃156')
    expect(collapseZeros('0.00000906')).toBe('0.0₅906')
    expect(collapseZeros('-0.00000906')).toBe('-0.0₅906')
  })

  it('leaves anything that is not a small decimal alone', () => {
    expect(collapseZeros('1,234.5678')).toBe('1,234.5678')
    expect(collapseZeros('2.5M')).toBe('2.5M')
    expect(collapseZeros('0')).toBe('0')
    expect(collapseZeros('—')).toBe('—')
    expect(collapseZeros('<0.0000000001')).toBe('<0.0000000001')
  })

  it('is an em dash for what it does not know, and never a zero', () => {
    // "we don't know" and "it's zero" are different facts about someone's money.
    expect(formatAmount(null)).toBe('—')
    expect(formatAmount(undefined)).toBe('—')
    expect(formatAmount(Number.NaN)).toBe('—')
    expect(formatAmount(Number.POSITIVE_INFINITY)).toBe('—')
  })
})
