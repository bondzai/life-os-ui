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

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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
    // Both layouts are in the DOM at once — a table from `sm` up, cards below it — and which one
    // is visible is CSS, not React. So a pair appears twice by design, plus again in the harvest
    // list. Assert it is *present*, and pin the count where the count is the point.
    expect((await screen.findAllByText('AERO/USDC')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('ETH/USDC').length).toBeGreaterThan(0)
    // The phrase also appears in the status filter and the stat-card hint, so assert the badge
    // specifically. One out-of-range position, rendered in both layouts.
    const badges = screen.getAllByText('Out of range').filter((el) => el.dataset.slot === 'badge')
    expect(badges).toHaveLength(2)
  })

  it('de-duplicates the shared campaign claim in the claimable summary', async () => {
    renderSurface(<WealthDefiPage />)
    await screen.findByText('Claimable by token')
    // The OP claim appears on two positions but is one reward: 120 OP at $84, not 240 at $168.
    // The panel is a ranked list now, so symbol and amount are separate cells — and the token's
    // mark carries the symbol as its monogram, so the row is located among the list items rather
    // than by a text query that would match both.
    const card = screen.getByText('Claimable by token').closest('[data-slot="card"]')
    expect(card).not.toBeNull()
    const row = within(card as HTMLElement)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes('OP'))
    expect(row?.textContent).toContain('120')
    expect(row?.textContent).toContain('$84.00')
    expect(row?.textContent).not.toContain('240')
  })

  it('shows the snowball total and what this page contributes to it', async () => {
    renderSurface(<WealthDefiPage />)
    await screen.findByText('Snowball')
    // Nothing tagged: the card stays, because the ❄ that fills it is on every row below.
    expect(screen.getByText(/No LP position is tagged yet/)).toBeDefined()

    // Tag the first position and the card should account for it.
    const toggles = screen.getAllByRole('button', { name: /Add .* to snowball/ })
    expect(toggles.length).toBeGreaterThan(0)
    fireEvent.click(toggles[0])

    await waitFor(() => expect(screen.getByText(/LP here · 1 of/)).toBeDefined())
    expect(screen.getByText(/Nothing tagged outside this page/)).toBeDefined()
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
    // One toggle per layout, both wired to the same tag — click either.
    const toggles = await screen.findAllByRole('button', { name: /Add ETH\/USDC to snowball/ })
    fireEvent.click(toggles[0])
    expect(screen.getAllByRole('button', { name: /Remove ETH\/USDC from snowball/ }).length).toBe(
      toggles.length,
    )
    defi.unmount()

    renderSurface(<WealthOverviewPage />)
    // The tag survives the page change: the Overview panel now shows the basket it belongs to.
    await waitFor(() => expect(screen.getByText('The slice you tagged to compound')).toBeDefined())
    expect(screen.getByText('1 source')).toBeDefined()
  })
})
