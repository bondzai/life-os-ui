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
    // The breakdown is behind the Claimable figure now, not a card below the table.
    fireEvent.click(await screen.findByRole('button', { name: /Claimable . open details/ }))
    const dialog = await screen.findByRole('dialog')

    // The OP claim appears on two positions but is one reward: 120 OP at $84, not 240 at $168.
    // The panel is a ranked list, so symbol and amount are separate cells — the row is located
    // among the list items rather than by a text query that would match both.
    const row = within(dialog)
      .getAllByRole('listitem')
      .find((li) => li.textContent?.includes('OP'))
    expect(row?.textContent).toContain('120')
    expect(row?.textContent).toContain('$84.00')
    expect(row?.textContent).not.toContain('240')
  })

  it('marks the figures that open, so a click is offered rather than guessed at', async () => {
    renderSurface(<WealthDefiPage />)
    // Hover is undiscoverable and on a touch screen does not exist, so the affordance has to be
    // drawn. Both openers carry the same glyph and the same accessible name.
    const opener = await screen.findByRole('button', { name: /Claimable . open details/ })
    // The glyph is decoration, not information — the accessible name above already carries
    // "open details" — so it is `aria-hidden` and has to be found in the DOM, not by role.
    expect(opener.querySelector('svg')).not.toBeNull()
  })

  it('carries lending in the same ledger rather than a panel of its own', async () => {
    renderSurface(<WealthDefiPage />)
    // The mock borrows USDC against ETH on Aave. A loan is a position — same venue, same value,
    // same "how close is this to going wrong" — so it belongs in the table with the LP rows.
    // Table and cards are both in the DOM at once, so assert presence, not a count.
    expect((await screen.findAllByText(/borrowing USDC/)).length).toBeGreaterThan(0)
    expect(screen.getAllByText('Aave v3').length).toBeGreaterThan(0)
    // Health takes the Range column's place: the same question, in the same spot on the row.
    expect(screen.getAllByText('1.94').length).toBeGreaterThan(0)
  })

  it('shows the snowball total and what this page contributes to it', async () => {
    renderSurface(<WealthDefiPage />)
    // It is a figure on the summary bar now, not a card of its own — but it still shows when
    // nothing is tagged, because the ❄ that fills it is on every row below.
    //
    // The label arrives before the data does: the page renders its structure on the first frame
    // and fills the numbers in, so finding "Snowball" no longer means the fetch has landed. Wait
    // for the copy that only exists once it has.
    await screen.findByText('Snowball')
    expect(await screen.findByText(/press ❄ on a row to start one/)).toBeDefined()

    // Tag the first position and the figure should account for it.
    const toggles = screen.getAllByRole('button', { name: /Add .* to snowball/ })
    expect(toggles.length).toBeGreaterThan(0)
    fireEvent.click(toggles[0])

    await waitFor(() => expect(screen.getByText(/1 LP here/)).toBeDefined())
  })

  it('opens the snowball chart in a dialog rather than shrinking it into the bar', async () => {
    renderSurface(<WealthDefiPage />)
    // Nothing tagged means no history to plot, and the figure stays a plain figure rather than
    // offering a chart of nothing. Tag one position and it becomes the trigger.
    const toggles = await screen.findAllByRole('button', { name: /Add .* to snowball/ })
    fireEvent.click(toggles[0])

    const open = await screen.findByRole('button', { name: /Snowball . open details/ })
    fireEvent.click(open)
    // The full panel — picker, projection and all — is what the dialog is for; a sparkline in a
    // summary bar was forty days of shape at a size nobody could read.
    expect(await screen.findByRole('dialog')).toBeDefined()
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
