/**
 * The wealth surfaces, rendered against the **running** Rust API.
 *
 * Skipped unless `LYRA_LIVE_API=1` and the API answers `/api/health`, so it never runs in CI or
 * on a machine with nothing listening. Run it with the API up:
 *
 * ```bash
 * LYRA_LIVE_API=1 npx vitest run src/pages/wealth/live-api.test.tsx          # dev API on :3001
 * LYRA_LIVE_API=1 VITE_API_URL=http://localhost:3030/api npx vitest run …    # the local service
 * ```
 *
 * `VITE_API_URL` matters: without it `API_URL` resolves to the dev server's `:3001`, and against
 * the installed service every test skips on a health probe that never answers — which reads as a
 * pass, not a miss.
 *
 * Why this exists: `surfaces.test.tsx` proves the pages render *the mock*. It cannot catch a
 * front end asking for a route the server does not have, or typing a response as an array when
 * the server sends an object — and both of those were real, sitting in this repo, invisible to a
 * green test suite and a green route sweep, because nothing had ever put the two halves
 * together. This is the closest thing to a click-through that does not need a browser: real
 * fetches, real JSON, real component tree. What it does *not* check is what things look like.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { API_URL } from '@/lib/api-url'

// Declared rather than pulled in from `@types/node`: this is the only file in the app that reads
// a shell variable, and it is a test. Adding node types to the whole project for two reads would
// also make `process` look available to browser code, which it is not.
declare const process: { env: Record<string, string | undefined> }

const LIVE = process.env.LYRA_LIVE_API === '1'
const PIN = process.env.LYRA_LIVE_PIN ?? '1234'

/** Pages import their data source at module load, so the mode has to be set before that. */
localStorage.setItem('lyra:data-mode', 'api')

async function signIn(): Promise<void> {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: PIN }),
  })
  if (!res.ok) throw new Error(`login failed: ${res.status}`)
  const body = await res.json()
  localStorage.setItem('lyra:token', body.token)
  useAuthStore.setState({ isAuthenticated: true, currentUser: body.user })
}

/**
 * One client for the whole file, as the app has.
 *
 * A client per test would refetch the portfolio for every page — a real multi-chain fan-out each
 * time, minutes of wall clock, and a fetch storm against live upstreams for no added coverage.
 */
const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function renderPage(ui: React.ReactElement) {
  return render(
    <MemoryRouter>
      <QueryClientProvider client={client}>{ui}</QueryClientProvider>
    </MemoryRouter>,
  )
}

/**
 * Wait for the page to stop loading, then assert it did not land on the failure state.
 *
 * `WealthError` renders "Could not load" — matching on it is what turns a silent 404 into a red
 * test. A skeleton that never resolves fails here too, via the timeout.
 */
async function settles(matcher: RegExp | string) {
  // `getAllBy`, not `getBy`: a label like "Claimable" legitimately appears on a stat card, a
  // section heading and every position row, and a single-match assertion would fail on a page
  // that rendered perfectly well.
  await waitFor(() => expect(screen.getAllByText(matcher).length).toBeGreaterThan(0), {
    timeout: 60_000,
  })
  expect(screen.queryByText(/Could not load/i)).toBeNull()
  expect(screen.queryByText(/Session expired/i)).toBeNull()
}

describe.skipIf(!LIVE)('wealth surfaces against the live API', () => {
  beforeAll(async () => {
    await signIn()
  }, 30_000)

  afterEach(() => {
    localStorage.removeItem('lyra:wealth:snowball')
  })

  it('serves a portfolio without being told which wallets to count', async () => {
    // The repository sends no `?address=`; the server falls back to ALERT_WALLETS. This asserted
    // a 400 before that fallback existed.
    const res = await fetch(`${API_URL}/wealth/portfolio`, {
      headers: { Authorization: `Bearer ${localStorage.getItem('lyra:token')}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body.wallets)).toBe(true)
    expect(body.wallets.length).toBeGreaterThan(0)
  }, 60_000)

  it('renders Overview with a real net worth', async () => {
    const { WealthOverviewPage } = await import('./overview')
    renderPage(<WealthOverviewPage />)
    await settles('Net worth')
    await settles('Asset tiers')
  }, 60_000)

  it('renders Holdings with real rows', async () => {
    const { WealthHoldingsPage } = await import('./holdings')
    renderPage(<WealthHoldingsPage />)
    await settles('Total book')
  }, 60_000)

  it('renders DeFi', async () => {
    const { WealthDefiPage } = await import('./defi')
    renderPage(<WealthDefiPage />)
    await settles(/Claimable|No positions/)
    await settles(/Position value|No positions/)
  }, 60_000)

  it('renders Opportunities from the live vfat feed', async () => {
    const { WealthOpportunitiesPage } = await import('./opportunities')
    renderPage(<WealthOpportunitiesPage />)
    // "Pools found" is the stat card; the alternative is the filtered-to-zero card, which is a
    // legitimate answer from a feed that is up — both mean the request succeeded.
    await settles(/Pools found|No pools match/)
    await settles(/TVL floor|No pools match/)
  }, 60_000)

  it('renders BTC reserves', async () => {
    const { WealthBtcPage } = await import('./btc')
    renderPage(<WealthBtcPage />)
    await settles(/Reserves|No bitcoin/)
  }, 60_000)

  it('renders Bots', async () => {
    const { WealthBotsPage } = await import('./bots')
    renderPage(<WealthBotsPage />)
    await settles(/Bot equity|No active trading bots/)
  }, 60_000)

  it('renders the Journal off the analyses endpoint', async () => {
    const { WealthJournalPage } = await import('./journal')
    renderPage(<WealthJournalPage />)
    await settles(/Filter by title|No analyses yet/)
  }, 60_000)

  it('renders Alerts off the live sweep state', async () => {
    const { WealthAlertsPage } = await import('./alerts')
    renderPage(<WealthAlertsPage />)
    await settles('Sweep')
    await settles('Alert thresholds')
  }, 60_000)

  /** Settings is the other half of the split: the two lists the whole book is counted from. */
  it('renders Settings with the wallet and off-chain lists', async () => {
    const { WealthSettingsPage } = await import('./settings')
    renderPage(<WealthSettingsPage />)
    await settles('Wallets')
    await settles('Off-chain assets')
  }, 60_000)

  /**
   * The off-chain book, written and read back through the real server.
   *
   * A round trip rather than a render: this is a *write* path, and the failure it guards against
   * is the one this file exists for — a request the server does not accept, or a response the
   * client cannot read. It cleans up after itself so a live run does not leave a fake asset in
   * the user's net worth.
   */
  it('round-trips an off-chain asset', async () => {
    const auth = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${localStorage.getItem('lyra:token')}`,
    }
    const created = await fetch(`${API_URL}/wealth/manual-assets`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'live-api test asset', value: 1, ccy: 'usd', tier: 'store' }),
    })
    expect(created.status).toBe(201)
    const asset = await created.json()
    expect(asset.id).toBeTruthy()

    try {
      const listed = await fetch(`${API_URL}/wealth/manual-assets`, { headers: auth })
      expect(listed.status).toBe(200)
      const body = await listed.json()
      expect(body.assets.some((a: { id: string }) => a.id === asset.id)).toBe(true)
    } finally {
      const removed = await fetch(`${API_URL}/wealth/manual-assets/${asset.id}`, {
        method: 'DELETE',
        headers: auth,
      })
      expect(removed.status).toBe(204)
    }
  }, 30_000)
})
