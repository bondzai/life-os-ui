/**
 * The hub.
 *
 * Four rules. **A tile opens `url`, never `base_url`** — the API door answers JSON, and this is the
 * one mistake that makes a launcher useless. **A disabled row is not a tile.** **Health is a word
 * as well as a colour**, because a dot alone is unreadable to anyone who cannot tell red from
 * green. And **grouping keeps the server's order**, so `sort` means something.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { HubPage } from './hub'

const NOW = Math.floor(Date.now() / 1000)

function system(over: Record<string, unknown> = {}) {
  return {
    id: 'sys-1',
    name: 'content-factory',
    kind: 'system',
    base_url: 'http://factory:8080',
    url: 'https://factory.tailnet.ts.net',
    icon: 'factory',
    category: 'Home server',
    sort: 0,
    token_preview: null,
    stored_token: false,
    scopes: ['read', 'propose'],
    enabled: true,
    cursor: null,
    last_ok_at: NOW - 60,
    last_error: null,
    failing_since: null,
    ...over,
  }
}

let payload: unknown = { systems: [], scopes: [] }

beforeEach(() => {
  useAuthStore.setState({ isAuthenticated: true })
  vi.stubGlobal(
    'fetch',
    // Routed by URL: the hub renders `WaitingOnYou`, which asks for decisions on the same client.
    // Answering both from one blob is how a test starts depending on which query resolves first.
    vi.fn(async (url: string) => ({
      ok: true,
      json: async () =>
        url.endsWith('/decisions') ? { decisions: [], waiting: 0 } : payload,
    })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAuthStore.setState({ isAuthenticated: false })
})

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <HubPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('the tiles', () => {
  it('opens the human URL, not the API door', async () => {
    // `base_url` answers JSON. A tile pointed at it is a tile that shows you a blob of text.
    payload = { systems: [system()], scopes: [] }
    mount()
    const link = await screen.findByRole('link', { name: /content-factory/ })
    expect(link.getAttribute('href')).toBe('https://factory.tailnet.ts.net')
    expect(link.getAttribute('target')).toBe('_blank')
  })

  it('falls back to the API door rather than rendering a dead tile', async () => {
    payload = { systems: [system({ url: null })], scopes: [] }
    mount()
    const link = await screen.findByRole('link', { name: /content-factory/ })
    expect(link.getAttribute('href')).toBe('http://factory:8080')
  })

  it('says health in words, not only in colour', async () => {
    payload = {
      systems: [
        system({ id: 'a', name: 'Up', last_ok_at: NOW - 30, last_error: null }),
        system({ id: 'b', name: 'Broken', last_error: 'connection refused', category: 'Home server' }),
        system({ id: 'c', name: 'Fresh', last_ok_at: null, last_error: null }),
      ],
      scopes: [],
    }
    mount()
    await screen.findByText('Broken')
    expect(screen.getByText('not answering')).toBeDefined()
    expect(screen.getByText('not checked yet')).toBeDefined()
    // And the header counts them, so you know before reading any tile.
    expect(screen.getByText(/1 up/)).toBeDefined()
    expect(screen.getByText(/1 not answering/)).toBeDefined()
  })

  it('leaves a disabled row off entirely', async () => {
    payload = {
      systems: [system(), system({ id: 'sys-2', name: 'Retired', enabled: false })],
      scopes: [],
    }
    mount()
    await screen.findByText('content-factory')
    expect(screen.queryByText('Retired')).toBeNull()
  })

  it('shows a monogram when the icon name is unknown', async () => {
    // Never a broken image: the page has no internet dependency, which is the point on a day the
    // house connection is the thing you are trying to diagnose.
    payload = { systems: [system({ icon: 'not-a-real-icon', name: 'Zebra' })], scopes: [] }
    mount()
    const link = await screen.findByRole('link', { name: /Zebra/ })
    expect(within(link).getByText('Z')).toBeDefined()
  })
})

describe('grouping', () => {
  it('keeps the order the server sorted them in', async () => {
    // A category appears where its first tile does. Alphabetical would silently ignore `sort`.
    payload = {
      systems: [
        system({ id: 'a', name: 'Zed', category: 'Zebra' }),
        system({ id: 'b', name: 'Alpha', category: 'Aardvark' }),
      ],
      scopes: [],
    }
    mount()
    await screen.findByText('Zed')
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)
    expect(headings).toEqual(['Zebra', 'Aardvark'])
  })

  it('files an uncategorised tile rather than dropping it', async () => {
    payload = { systems: [system({ category: null })], scopes: [] }
    mount()
    expect(await screen.findByText('Everything else')).toBeDefined()
  })
})

describe('when there is nothing', () => {
  it('says how to add one', async () => {
    payload = { systems: [], scopes: [] }
    mount()
    expect(await screen.findByText('Nothing on the network yet')).toBeDefined()
    await waitFor(() => expect(screen.queryByText(/Reading the network/)).toBeNull())
  })
})

describe('everything red at once', () => {
  it('reads as one fault, not many', async () => {
    // Two services failing in the same minute is possible. Eight is Tailscale on the box, and
    // reporting that as eight faults sends you to check eight things.
    payload = {
      systems: [
        system({ id: 'a', name: 'Alpha', last_ok_at: null, last_error: 'connection refused' }),
        system({ id: 'b', name: 'Beta', last_ok_at: null, last_error: 'connection refused' }),
        system({ id: 'c', name: 'Gamma', last_ok_at: null, last_error: 'timed out' }),
      ],
      scopes: [],
    }
    mount()
    const banner = await screen.findByRole('alert')
    expect(within(banner).getByText(/Nothing on the network is answering/)).toBeDefined()
    expect(banner.textContent).toContain('tailscale status')
  })

  it('says nothing when one is down and another is up', async () => {
    // One service down is one service down. The banner must not cry wolf.
    payload = {
      systems: [
        system({ id: 'a', name: 'Alpha', last_error: 'connection refused', last_ok_at: null }),
        system({ id: 'b', name: 'Beta' }),
      ],
      scopes: [],
    }
    mount()
    await screen.findByText('Beta')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says nothing when only one system exists at all', async () => {
    payload = { systems: [system({ last_error: 'refused', last_ok_at: null })], scopes: [] }
    mount()
    await screen.findByText('content-factory')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('filtering', () => {
  const many = Array.from({ length: 8 }, (_, n) =>
    system({ id: `s${n}`, name: `Service ${n}`, category: n < 4 ? 'First' : 'Second' }),
  )

  it('stays out of the way until there are enough tiles to hunt through', async () => {
    payload = { systems: [system()], scopes: [] }
    mount()
    await screen.findByText('content-factory')
    expect(screen.queryByLabelText('Filter the network')).toBeNull()
  })

  it('narrows by name, group or address', async () => {
    payload = { systems: many, scopes: [] }
    mount()
    const box = await screen.findByLabelText('Filter the network')

    fireEvent.change(box, { target: { value: 'Service 7' } })
    expect(screen.getAllByRole('link')).toHaveLength(1)

    // The group you filed it under.
    fireEvent.change(box, { target: { value: 'second' } })
    expect(screen.getAllByRole('link')).toHaveLength(4)

    // And the address, which is often the only thing you remember about a box you visit twice
    // a year.
    fireEvent.change(box, { target: { value: 'tailnet.ts.net' } })
    expect(screen.getAllByRole('link')).toHaveLength(8)
  })

  it('counts the whole network, not the filter', async () => {
    // "3 up" has to mean the network. Counting the filter would make the header change as you type.
    payload = { systems: many, scopes: [] }
    mount()
    const box = await screen.findByLabelText('Filter the network')
    fireEvent.change(box, { target: { value: 'Service 7' } })
    expect(screen.getByText(/8 up/)).toBeDefined()
  })

  it('says so when nothing matches, rather than looking empty', async () => {
    payload = { systems: many, scopes: [] }
    mount()
    fireEvent.change(await screen.findByLabelText('Filter the network'), {
      target: { value: 'zzzz' },
    })
    expect(screen.getByText(/Nothing matches/)).toBeDefined()
    expect(screen.queryByText('Nothing on the network yet')).toBeNull()
  })

  it('opens the top hit on Enter', async () => {
    payload = { systems: many, scopes: [] }
    const open = vi.fn()
    vi.stubGlobal('open', open)
    mount()
    const box = await screen.findByLabelText('Filter the network')
    fireEvent.change(box, { target: { value: 'Service 5' } })
    fireEvent.keyDown(box, { key: 'Enter' })
    expect(open).toHaveBeenCalledWith('https://factory.tailnet.ts.net', '_blank', 'noreferrer')
  })
})
