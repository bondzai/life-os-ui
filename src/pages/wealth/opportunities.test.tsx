/**
 * Opportunities — the discovery board.
 *
 * Two things are worth pinning here. The formatters, because they are the only place a number
 * changes shape on its way to the screen and both have a scale where the naive version misleads.
 * And the demo-session guard, because the page is live-only: its rows are real pools on real
 * chains, and a mock would be indistinguishable from the real thing on a surface whose whole job
 * is to be trusted enough to act on.
 *
 * The suite pins `VITE_USE_API: 'false'` (see `vite.config.ts`), so the render test exercises the
 * demo path. The live path is covered by `live-api.test.tsx` behind `LYRA_LIVE_API=1`.
 */

import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it } from 'vitest'
import {
  emissionShare,
  formatApr,
  formatAprMix,
  formatFee,
  windowCaveat,
} from './opportunities-format'
import { WealthOpportunitiesPage } from './opportunities'

function renderSurface(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

describe('formatApr', () => {
  it('keeps one decimal at the scale people actually farm at', () => {
    expect(formatApr(72.4)).toBe('72.4%')
    expect(formatApr(0)).toBe('0.0%')
    expect(formatApr(999.94)).toBe('999.9%')
  })

  it('drops the decimal once the number is too silly to act on', () => {
    // The real top of an unfiltered APR sort on Base — a $275 pool. `3129115.9%` reads as a
    // parsing bug; the rounded form reads as the dust it is.
    expect(formatApr(3_129_115.97)).toBe('3,129,116%')
    expect(formatApr(1000)).toBe('1,000%')
  })

  it('renders missing as a dash, never as zero', () => {
    expect(formatApr(null)).toBe('—')
    expect(formatApr(undefined)).toBe('—')
    expect(formatApr(Number.NaN)).toBe('—')
  })
})

describe('formatFee', () => {
  it('reads the feedscale — hundredths of a basis point', () => {
    expect(formatFee(3000)).toBe('0.30%')
    expect(formatFee(10_000)).toBe('1.00%')
  })

  it('keeps the two smallest tiers apart', () => {
    // One decimal would collapse both of these to "0.0%".
    expect(formatFee(100)).toBe('0.01%')
    expect(formatFee(500)).toBe('0.05%')
  })

  it('renders missing as a dash', () => {
    expect(formatFee(null)).toBe('—')
    expect(formatFee(undefined)).toBe('—')
  })
})

describe('formatAprMix', () => {
  it('names what pays the yield, in feed order', () => {
    expect(
      formatAprMix([
        { kind: 'swapFees', apr: 61.2 },
        { kind: 'offChainRewards', apr: 18.8 },
      ]),
    ).toBe('fees 61% · rewards 19%')
  })

  it('passes an unknown component kind through rather than hiding it', () => {
    expect(formatAprMix([{ kind: 'somethingNew', apr: 5 }])).toBe('somethingNew 5%')
  })

  it('says nothing when the feed explained nothing', () => {
    expect(formatAprMix(undefined)).toBe('')
    expect(formatAprMix([])).toBe('')
  })
})

describe('emissionShare', () => {
  it('measures the part that stops when a programme does', () => {
    const share = emissionShare([
      { kind: 'swapFees', apr: 60 },
      { kind: 'offChainRewards', apr: 40 },
    ])
    expect(share).toBeCloseTo(0.4)
  })

  it('counts staking as an emission, not a fee', () => {
    expect(emissionShare([{ kind: 'staking', apr: 106 }])).toBe(1)
  })

  it('is null when unknowable — never zero, which would claim it is all fees', () => {
    expect(emissionShare(undefined)).toBeNull()
    expect(emissionShare([])).toBeNull()
    expect(emissionShare([{ kind: 'swapFees', apr: 0 }])).toBeNull()
  })
})

describe('windowCaveat', () => {
  it('flags a week of APR measured over a day', () => {
    // The live shape: a declared 7-day window with 1.04 days behind it.
    expect(windowCaveat({ fee_window_days: 7, effective_fee_window_days: 1.04 })).toBe(
      '7-day APR measured over 1.0 days',
    )
  })

  it('stays quiet when the window is honest, or nearly so', () => {
    expect(windowCaveat({ fee_window_days: 7, effective_fee_window_days: 7 })).toBeNull()
    // A tenth of a day is rounding, not a caveat.
    expect(windowCaveat({ fee_window_days: 7, effective_fee_window_days: 6.95 })).toBeNull()
  })

  it('stays quiet when the feed said nothing about the window', () => {
    expect(windowCaveat({})).toBeNull()
  })
})

describe('Opportunities', () => {
  it('asks a demo session to switch to live data rather than inventing pools', () => {
    renderSurface(<WealthOpportunitiesPage />)
    expect(screen.getByText(/needs the live backend/i)).toBeDefined()
  })

  it('does not render a table when there is no live backend', () => {
    renderSurface(<WealthOpportunitiesPage />)
    // An empty table with filter controls would imply the feed answered and had nothing.
    expect(screen.queryByLabelText('Minimum APR')).toBeNull()
    expect(screen.queryByRole('table')).toBeNull()
  })
})
