/**
 * The off-chain book: the editor, and the one-time handover of the browser's old list.
 *
 * Two things are worth a test here rather than a click-through. The editor must refuse a typo in
 * the amount instead of recording it as zero, and the import must be **resumable** — a batch that
 * fails halfway has to leave exactly the un-imported rows behind, because the alternative is
 * silently duplicating or losing what the user owns.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import {
  MANUAL_ASSETS_IMPORTED_KEY,
  MANUAL_ASSETS_KEY,
  apiWealthRepository,
} from '@/core/repositories/api-wealth-repository'
import { mockWealthSource } from './data-source'
import { OffChainAssets } from './off-chain'
import { useMoney } from './money'

/** A stand-in for any of the 55 places a wealth surface renders money. */
function Denominated() {
  const { money } = useMoney()
  return <span data-testid="amount">{money(100)}</span>
}

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <OffChainAssets />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  useAuthStore.setState({ isAuthenticated: true })
})

afterEach(() => {
  useAuthStore.setState({ isAuthenticated: false })
  localStorage.clear()
  vi.restoreAllMocks()
})

describe('the editor', () => {
  it('lists what is already recorded', async () => {
    renderCard()
    expect(await screen.findByText('Cold storage BTC')).toBeTruthy()
    expect(screen.getByText('THB savings')).toBeTruthy()
  })

  it('adds an asset through the data source', async () => {
    const create = vi.spyOn(mockWealthSource, 'createManualAsset')
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: /add/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Vault gold' } })
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '4200' } })
    fireEvent.click(screen.getByRole('button', { name: /add asset/i }))

    await waitFor(() => expect(create).toHaveBeenCalledOnce())
    expect(create.mock.calls[0][0]).toMatchObject({ name: 'Vault gold', value: 4200, tier: 'store' })
  })

  /** `Number('about 200')` is NaN and `Number('')` is 0; neither may reach the server as a balance. */
  it('refuses an amount that is not a number instead of recording zero', async () => {
    const create = vi.spyOn(mockWealthSource, 'createManualAsset')
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: /add/i }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Typo' } })
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: 'about 200' } })
    fireEvent.click(screen.getByRole('button', { name: /add asset/i }))

    // The form is still open with the bad value in it, and nothing was sent.
    await waitFor(() => expect(screen.getByLabelText('Amount')).toHaveProperty('value', 'about 200'))
    expect(create).not.toHaveBeenCalled()
  })

  it('removes an asset', async () => {
    const remove = vi.spyOn(mockWealthSource, 'deleteManualAsset')
    renderCard()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Cold storage BTC' }))
    await waitFor(() => expect(remove).toHaveBeenCalledOnce())
  })
})

describe('importing the browser list', () => {
  const asset = (name: string) => ({ name, value: 1, ccy: 'usd', tier: 'store' })

  /** A `fetch` that answers `GET` with an empty book and lets each write be scripted. */
  function stubFetch(writes: (() => Response)[]) {
    let write = 0
    return vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => {
      if ((init?.method ?? 'GET') === 'GET') {
        return Promise.resolve(new Response(JSON.stringify({ assets: [] }), { status: 200 }))
      }
      return Promise.resolve(writes[write++]())
    })
  }

  const ok = () => new Response(JSON.stringify({ id: 'server-id' }), { status: 201 })
  const boom = () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })

  it('hands every row over and keeps a local backup of what was accepted', async () => {
    localStorage.setItem(MANUAL_ASSETS_KEY, JSON.stringify([asset('one'), asset('two')]))
    const fetchSpy = stubFetch([ok, ok])

    await apiWealthRepository.getManualAssets()

    const posts = fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST')
    expect(posts).toHaveLength(2)
    expect(JSON.parse(localStorage.getItem(MANUAL_ASSETS_KEY)!)).toEqual([])
    expect(JSON.parse(localStorage.getItem(MANUAL_ASSETS_IMPORTED_KEY)!)).toHaveLength(2)
  })

  it('leaves exactly the un-imported rows behind when a write fails', async () => {
    localStorage.setItem(
      MANUAL_ASSETS_KEY,
      JSON.stringify([asset('one'), asset('two'), asset('three')]),
    )
    stubFetch([ok, boom])
    vi.spyOn(console, 'error').mockImplementation(() => {})

    await apiWealthRepository.getManualAssets()

    // "one" landed; "two" failed and "three" was never attempted, so both stay queued.
    const queued = JSON.parse(localStorage.getItem(MANUAL_ASSETS_KEY)!)
    expect(queued.map((a: { name: string }) => a.name)).toEqual(['two', 'three'])
    expect(JSON.parse(localStorage.getItem(MANUAL_ASSETS_IMPORTED_KEY)!)).toHaveLength(1)
  })

  it('re-attempts only what is still queued on the next read', async () => {
    localStorage.setItem(MANUAL_ASSETS_KEY, JSON.stringify([asset('one'), asset('two')]))
    stubFetch([ok, boom])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await apiWealthRepository.getManualAssets()
    vi.restoreAllMocks()

    const second = stubFetch([ok])
    await apiWealthRepository.getManualAssets()

    // One POST, not three: "one" is not offered a second time.
    expect(second.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem(MANUAL_ASSETS_KEY)!)).toEqual([])
  })

  it('does not touch the network when there is nothing to import', async () => {
    const fetchSpy = stubFetch([])
    await apiWealthRepository.getManualAssets()
    expect(fetchSpy.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0)
  })
})

describe('the currency switch', () => {
  it('re-denominates every surface and survives a reload', async () => {
    const { CurrencySwitch } = await import('./currency-switch')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    // The switch reads rates from the shared portfolio cache; seed it rather than fetch.
    client.setQueryData(['wealth', 'portfolio'], {
      wallets: [],
      total: 0,
      rates: { usd: 1, thb: 32.915, btc_usd: 74_815 },
      fetched_at: 0,
    })

    render(
      <QueryClientProvider client={client}>
        <CurrencySwitch />
        <Denominated />
      </QueryClientProvider>,
    )

    expect((await screen.findByTestId('amount')).textContent).toBe('$100.00')
    fireEvent.click(screen.getByText('thb'))
    await waitFor(() => expect(screen.getByTestId('amount').textContent).toBe('฿3,292'))
    // The choice is the session's, so it outlives the components that read it.
    expect(localStorage.getItem('lyra:wealth:currency')).toBe('thb')

    fireEvent.click(screen.getByText('sats'))
    await waitFor(() => expect(screen.getByTestId('amount').textContent).toBe('133,663 sats'))

    // Back to USD, so the module-level store does not leak into the next test.
    fireEvent.click(screen.getByText('usd'))
    await waitFor(() => expect(screen.getByTestId('amount').textContent).toBe('$100.00'))
  })

  /** With no rate there is nothing to switch to, and blanking every number would be worse. */
  it('disables a currency whose rate the box has not got', async () => {
    const { CurrencySwitch } = await import('./currency-switch')
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    client.setQueryData(['wealth', 'portfolio'], {
      wallets: [],
      total: 0,
      rates: { usd: 1 },
      fetched_at: 0,
    })

    render(
      <QueryClientProvider client={client}>
        <CurrencySwitch />
      </QueryClientProvider>,
    )
    expect(screen.getByText('thb').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('sats').hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('usd').hasAttribute('disabled')).toBe(false)
  })
})
