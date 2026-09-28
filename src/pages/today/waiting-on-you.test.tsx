/**
 * The decision inbox on Today.
 *
 * Three rules are worth testing. **It disappears when there is nothing waiting**, because a panel
 * that is usually empty must cost nothing at the top of the day. **The evidence is shown with the
 * question**, since a one-tap answer without the reason is a coin flip. And **a tap says "on its
 * way", not "sent"** — the answer is committed in Lyra and delivered by a retrying job, so
 * claiming delivery would be a lie whenever the origin is down.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { WaitingOnYou } from './waiting-on-you'

const NOW = Math.floor(Date.now() / 1000)

const ONE_WAITING = {
  waiting: 1,
  decisions: [
    {
      id: 'dec-1',
      system_id: 'sys-1',
      external_id: 'cf-7',
      question: 'Medieval week 1: castles or alliances?',
      detail: "next week's order",
      options: [
        { value: 'castles', label: 'Castles' },
        { value: 'alliances', label: 'Alliances' },
      ],
      evidence: 'castles tested 9% better in the Ancient finale',
      raised_at: NOW - 3600,
      expires_at: null,
      answer: null,
      answered_at: null,
      delivered_at: null,
      expired: false,
    },
  ],
}

let sent: { method: string; url: string; body: unknown }[] = []
let payload: unknown = { decisions: [], waiting: 0 }

beforeEach(() => {
  sent = []
  useAuthStore.setState({ isAuthenticated: true })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      sent.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (method === 'GET') return { ok: true, json: async () => payload }
      return { ok: true, json: async () => ({ ok: true }) }
    }),
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
        <WaitingOnYou />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('when nothing is waiting', () => {
  it('renders nothing at all', async () => {
    payload = { decisions: [], waiting: 0 }
    const { container } = mount()
    await waitFor(() => expect(sent.length).toBeGreaterThan(0))
    // Not an empty state, not a heading — nothing. This sits above your day every single morning.
    expect(container.textContent).toBe('')
    expect(screen.queryByText('Waiting on you')).toBeNull()
  })

  it('renders nothing for a decision that is already answered and delivered', async () => {
    payload = {
      waiting: 0,
      decisions: [
        { ...ONE_WAITING.decisions[0], answer: 'castles', answered_at: NOW, delivered_at: NOW },
      ],
    }
    const { container } = mount()
    await waitFor(() => expect(sent.length).toBeGreaterThan(0))
    expect(container.textContent).toBe('')
  })
})

describe('a decision waiting', () => {
  it('shows the question with the reason the system is asking', async () => {
    payload = ONE_WAITING
    mount()
    const item = await screen.findByRole('listitem')
    expect(within(item).getByText(/castles or alliances/)).toBeDefined()
    expect(within(item).getByText("next week's order")).toBeDefined()
    // The evidence is the difference between deciding and guessing.
    expect(within(item).getByText(/tested 9% better/)).toBeDefined()
    expect(within(item).getByText(/asked/)).toBeDefined()
  })

  it('offers exactly the answers the origin published', async () => {
    payload = ONE_WAITING
    mount()
    const item = await screen.findByRole('listitem')
    const buttons = within(item)
      .getAllByRole('button')
      .map((b) => b.textContent)
    expect(buttons).toEqual(['Castles', 'Alliances'])
  })

  it('posts the value, not the label', async () => {
    // The label is for you; the value is what the origin knows how to act on.
    payload = ONE_WAITING
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Castles' }))

    await waitFor(() => {
      const post = sent.find((r) => r.method === 'POST')
      expect(post).toBeDefined()
      expect(post!.url.endsWith('/decisions/dec-1/answer')).toBe(true)
      expect(post!.body).toEqual({ answer: 'castles' })
    })
  })

  it('says the answer is on its way, never that it was sent', async () => {
    payload = ONE_WAITING
    mount()
    fireEvent.click(await screen.findByRole('button', { name: 'Castles' }))

    const confirmation = await screen.findByText(/on its way back/)
    expect(confirmation).toBeDefined()
    // "Sent" would be a lie whenever the origin is down, which is exactly when it matters.
    expect(screen.queryByText(/\bsent\b/i)).toBeNull()
  })

  it('says when a deadline has already passed', async () => {
    // Shown rather than hidden: a clean-looking inbox while a factory waits is the failure mode.
    payload = {
      waiting: 1,
      decisions: [{ ...ONE_WAITING.decisions[0], expires_at: NOW - 60, expired: true }],
    }
    mount()
    expect(await screen.findByText(/past its deadline/)).toBeDefined()
    // And it is still answerable — deciding late beats not deciding.
    expect(screen.getByRole('button', { name: 'Castles' })).toBeDefined()
  })
})

describe('an answer still travelling', () => {
  it('is counted without taking up a row', async () => {
    payload = {
      waiting: 0,
      decisions: [
        { ...ONE_WAITING.decisions[0], answer: 'castles', answered_at: NOW, delivered_at: null },
      ],
    }
    mount()
    expect(await screen.findByText(/1 answer is on the way back/)).toBeDefined()
    expect(screen.queryByRole('listitem')).toBeNull()
  })
})
