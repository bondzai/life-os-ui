/**
 * The Agents page's job controls.
 *
 * The rule under test is which action each row offers, because the wrong one is harmful rather
 * than merely useless: Retry on a queued job would run it twice, and Cancel on a running one
 * cannot be honoured.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { AgentsPage } from './agents'

const QUEUE = {
  counts: { queued: 1, running: 0, failed: 1 },
  oldest_queued_secs: 12,
  recent: [
    { id: 'dead', kind: 'deliver.telegram', lane: 'deliver', status: 'failed', attempts: 5, max_attempts: 5, updated_at: 2, last_error: 'connection reset' },
    { id: 'waiting', kind: 'digest.daily', lane: 'batch', status: 'queued', attempts: 0, max_attempts: 12, updated_at: 1, last_error: null },
    { id: 'fine', kind: 'snapshot.networth', lane: 'batch', status: 'done', attempts: 1, max_attempts: 6, updated_at: 0, last_error: null },
  ],
}

let posts: string[] = []

beforeEach(() => {
  posts = []
  useAuthStore.setState({ isAuthenticated: true })
  // The fleet socket is exercised by its own tests; here it only has to exist and stay quiet.
  vi.stubGlobal(
    'WebSocket',
    class {
      close() {}
    },
  )
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(url)
        return { ok: true, json: async () => ({ id: 'new', created: true, ticket: 't' }) }
      }
      return { ok: true, json: async () => QUEUE }
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
        <AgentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function row(kind: string) {
  return screen.getByText(kind).closest('li') as HTMLElement
}

describe('Recent work', () => {
  it('offers Retry on a failed job and nothing else', async () => {
    mount()
    await screen.findByText('deliver.telegram')
    const dead = row('deliver.telegram')
    expect(within(dead).getByRole('button', { name: 'Retry' })).toBeDefined()
    expect(within(dead).queryByRole('button', { name: 'Cancel' })).toBeNull()
    // Why it died is shown, because it is the reason the row was kept.
    expect(within(dead).getByText('connection reset')).toBeDefined()
  })

  it('offers Cancel on a queued job and never Retry, which would run it twice', async () => {
    mount()
    await screen.findByText('digest.daily')
    const waiting = row('digest.daily')
    expect(within(waiting).getByRole('button', { name: 'Cancel' })).toBeDefined()
    expect(within(waiting).queryByRole('button', { name: 'Retry' })).toBeNull()
  })

  it('offers nothing on work that finished well', async () => {
    mount()
    await screen.findByText('snapshot.networth')
    expect(within(row('snapshot.networth')).queryByRole('button')).toBeNull()
  })

  it('posts the retry to that job', async () => {
    mount()
    await screen.findByText('deliver.telegram')
    fireEvent.click(within(row('deliver.telegram')).getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(posts.some((u) => u.endsWith('/jobs/dead/retry'))).toBe(true))
  })
})
