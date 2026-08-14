/**
 * Render smoke tests for the three wealth surfaces.
 *
 * The routes are not wired yet, so nothing else in the app imports these pages — without this
 * file a runtime error (a bad chart prop, an undefined field) would not surface until someone
 * clicked the nav item. Each surface is mounted against the real mock data source and asserted
 * to reach a rendered state rather than an error boundary.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { WealthOverviewPage } from './overview'
import { WealthHoldingsPage } from './holdings'
import { WealthDefiPage } from './defi'

function renderSurface(ui: React.ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>)
}

beforeEach(() => {
  // The hooks are gated on auth; without this they never fetch and every page shows a skeleton.
  useAuthStore.setState({ isAuthenticated: true })
})

afterEach(() => {
  useAuthStore.setState({ isAuthenticated: false })
})

describe('Overview', () => {
  it('renders the headline metrics from the mock portfolio', async () => {
    renderSurface(<WealthOverviewPage />)
    expect(await screen.findByText('Net worth')).toBeDefined()
    await waitFor(() => expect(screen.getByText('Asset tiers')).toBeDefined())
    // All three tiers should be labelled, proving the split rendered rather than collapsing.
    expect(screen.getByText('Store')).toBeDefined()
    expect(screen.getByText('Business')).toBeDefined()
    expect(screen.getByText('Trading')).toBeDefined()
  })

  it('shows the debt qualifier, since the mock has an open borrow', async () => {
    renderSurface(<WealthOverviewPage />)
    expect(await screen.findByText(/after .* debt/)).toBeDefined()
  })
})

describe('Holdings', () => {
  it('renders the ledger with per-chain rows', async () => {
    renderSurface(<WealthHoldingsPage />)
    expect(await screen.findByText('Total book')).toBeDefined()
    // ETH is held on both Ethereum and Base in the mock and must not be merged into one row.
    await waitFor(() => expect(screen.getAllByText('ETH').length).toBeGreaterThan(1))
  })

  it('offers the filter controls', async () => {
    renderSurface(<WealthHoldingsPage />)
    expect(await screen.findByPlaceholderText(/Search asset/)).toBeDefined()
  })
})

describe('DeFi', () => {
  it('renders LP positions and flags the out-of-range one', async () => {
    renderSurface(<WealthDefiPage />)
    expect(await screen.findByText('AERO/USDC')).toBeDefined()
    expect(screen.getByText('ETH/USDC')).toBeDefined()
    // The phrase also appears in the status filter and the stat-card hint, so assert the badge
    // specifically rather than that the words exist somewhere on the page.
    const badges = screen.getAllByText('Out of range').filter((el) => el.dataset.slot === 'badge')
    expect(badges).toHaveLength(1)
  })

  it('de-duplicates the shared campaign claim in the claimable summary', async () => {
    renderSurface(<WealthDefiPage />)
    await screen.findByText('Claimable by token')
    // The OP claim appears on two positions but is one reward: 120 OP, not 240.
    expect(screen.getByText('120 OP')).toBeDefined()
  })
})
