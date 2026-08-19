/**
 * Render smoke tests for the wealth surfaces.
 *
 * The pages are lazy-routed, so a runtime error in one — a bad chart prop, an undefined field —
 * shows up only when someone clicks that nav item. Each surface is mounted here against the mock
 * data source and asserted to reach a rendered state rather than an error boundary.
 *
 * Journal and Alerts are not covered: they read the API directly rather than through the wealth
 * data source, so mounting them here would test a `fetch` mock rather than the page.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { WealthOverviewPage } from './overview'
import { WealthHoldingsPage } from './holdings'
import { WealthDefiPage } from './defi'
import { WealthBotsPage } from './bots'
import { WealthBtcPage } from './btc'

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
  // Snowball tags and the sats target live in localStorage; leaving them set would carry one
  // test's tagging into the next one's assertions.
  localStorage.clear()
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
    // A pair can legitimately appear twice: once as a position card, once in the harvest list
    // below it. Assert the position heading specifically rather than page-wide uniqueness.
    const headings = await screen.findAllByRole('heading', { name: 'AERO/USDC' })
    expect(headings).toHaveLength(1)
    expect(screen.getAllByRole('heading', { name: 'ETH/USDC' })).toHaveLength(1)
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

describe('BTC', () => {
  it('reports reserves with wrappers folded in', async () => {
    renderSurface(<WealthBtcPage />)
    expect(await screen.findByText('Reserves')).toBeDefined()
    // Wrappers are the point of the panel: a WBTC balance must show up as bitcoin held.
    expect(screen.getByText('Composition')).toBeDefined()
  })
})

describe('Bots', () => {
  it('renders each strategy with its equity', async () => {
    renderSurface(<WealthBotsPage />)
    expect(await screen.findByText('Bot equity')).toBeDefined()
  })
})

describe('Snowball', () => {
  it('stays out of the way until something is tagged', async () => {
    renderSurface(<WealthOverviewPage />)
    expect(await screen.findByText('Snowball')).toBeDefined()
    // No basket yet, so the panel offers the picker instead of a total.
    expect(screen.getByRole('button', { name: 'Choose sources' })).toBeDefined()
  })

  it('counts a position into the basket once it is tagged on DeFi', async () => {
    const defi = renderSurface(<WealthDefiPage />)
    const toggle = await screen.findByRole('button', { name: /Add ETH\/USDC to snowball/ })
    fireEvent.click(toggle)
    expect(screen.getByRole('button', { name: /Remove ETH\/USDC from snowball/ })).toBeDefined()
    defi.unmount()

    renderSurface(<WealthOverviewPage />)
    // The tag survives the page change: the Overview panel now shows the basket it belongs to.
    await waitFor(() => expect(screen.getByText('The slice you tagged to compound')).toBeDefined())
    expect(screen.getByText('1 source')).toBeDefined()
  })
})
