/**
 * The Agents page: the job log and the office view.
 *
 * The rule under test in the log is which action each line offers, because the wrong one is
 * harmful rather than merely useless: Retry on a queued job would run it twice, and Cancel on a
 * running one cannot be honoured.
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

/** A log line, found by the kind it prints — which in the log is the system's own name. */
function row(kind: string) {
  return screen.getByText(kind).closest('li') as HTMLElement
}

describe('The job log', () => {
  it('offers Retry on a failed job and nothing else', async () => {
    mount()
    await screen.findByText('deliver.telegram')
    const dead = row('deliver.telegram')
    expect(within(dead).getByRole('button', { name: 'Retry' })).toBeDefined()
    expect(within(dead).queryByRole('button', { name: 'Cancel' })).toBeNull()
    // Why it died is shown, because it is the reason the line was kept — indented onto its own
    // line like a stack trace, so it never pushes the columns out of alignment.
    expect(within(dead).getByText(/connection reset/)).toBeDefined()
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

  it('prints the system name, because that is what a log is for', async () => {
    // The desks above say "Send a message"; the log says `deliver.telegram`. A log is read by
    // lining rows up and spotting the one that differs, and the raw kind is what lines up. The
    // plain-words label is on hover, the inverse of everywhere else on the page.
    mount()
    const label = await screen.findByText('deliver.telegram')
    expect(label.getAttribute('title')).toBe('Send a message')
  })

  it('stamps each line with the time and a level, the way a log does', async () => {
    mount()
    const dead = await screen.findByText('deliver.telegram')
    const line = dead.closest('li') as HTMLElement
    expect(within(line).getByText('FAIL')).toBeDefined()
    // The attempt count earns its place only once something has gone wrong.
    expect(within(line).getByText('5/5')).toBeDefined()
    expect(within(line).getByRole('time')).toBeDefined()
  })

  it('reads oldest first, the way a terminal appends', async () => {
    mount()
    await screen.findByText('deliver.telegram')
    const printed = screen.getAllByRole('listitem').map((li) => li.querySelector('time')?.textContent)
    const times = printed.filter(Boolean) as string[]
    expect([...times].sort()).toEqual(times)
  })

  it('says the queue could not be read rather than showing a dash that looks like nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/jobs')
          ? { ok: false, status: 500, json: async () => ({}) }
          : { ok: true, json: async () => ({ ticket: 't', agents: [] }) },
      ),
    )
    mount()
    expect(await screen.findByText(/could not read the queue/)).toBeDefined()
  })
})

/**
 * The office view.
 *
 * What is under test is that a desk speaks for itself: who sits there, what they are for, and —
 * crucially — what an *idle* one has to say. A desk that goes blank between jobs reads as broken,
 * which is the opposite of what this page is for.
 */
describe('The office', () => {
  /** The last socket the hook opened, so a test can hand it frames. */
  type FakeSocket = { onopen?: () => void; onmessage?: (e: { data: string }) => void }
  let opened: FakeSocket | null = null
  const capture = (ws: FakeSocket) => {
    opened = ws
  }

  async function desk(name: string) {
    return (await screen.findByText(name)).closest('li') as HTMLElement
  }

  async function office(agents: unknown[]) {
    vi.stubGlobal(
      'WebSocket',
      class {
        onopen?: () => void
        onmessage?: (e: { data: string }) => void
        constructor() {
          capture(this)
        }
        close() {}
      },
    )
    mount()
    await waitFor(() => expect(opened).not.toBeNull())
    opened!.onopen?.()
    opened!.onmessage?.({ data: JSON.stringify({ type: 'snapshot', agents, at: 0 }) })
  }

  const AGENT = {
    id: 'batch-0@1',
    name: 'Analyst',
    role: 'Reads the book',
    lane: 'batch',
    status: 'idle',
    last_seen: Math.floor(Date.now() / 1000) - 30,
    done: 4,
    failed: 0,
  }

  it('puts a name and a role on every desk, in the room for its lane', async () => {
    await office([AGENT, { ...AGENT, id: 'deliver-0@1', name: 'Relay', role: 'Sends messages', lane: 'deliver' }])
    expect(await screen.findByText('Analyst')).toBeDefined()
    expect(screen.getByText('Reads the book')).toBeDefined()
    // The room heading is the lane in plain words. (The raw lane is on the heading's title, but
    // it is not unique on the page — Recent work labels its lanes the same way.)
    expect(screen.getByRole('heading', { name: 'Background' })).toBeDefined()
    expect(screen.getByRole('heading', { name: 'Messages' })).toBeDefined()
  })

  it('lets an idle desk say what it last did, and whether it worked', async () => {
    await office([{ ...AGENT, last_kind: 'snapshot.networth', last_ok: false, failed: 1 }])
    const card = await desk('Analyst')
    await waitFor(() => expect(within(card).getByText('Free')).toBeDefined())
    // The outcome is a character, not only a colour, so it survives greyscale.
    const last = within(card).getByTitle('snapshot.networth')
    expect(last.textContent).toContain('Net-worth snapshot')
    expect(last.textContent).toContain('✗')
    expect(within(card).getByText(/1 failed/)).toBeDefined()
  })

  it('says a fresh desk has nothing to do rather than going blank', async () => {
    await office([AGENT])
    expect(await screen.findByText('Nothing to do yet')).toBeDefined()
  })

  it('shows the job on a working desk, with the word beside the light', async () => {
    await office([
      {
        ...AGENT,
        status: 'working',
        job: { id: 'j1', kind: 'digest.daily', attempt: 2, started_at: Math.floor(Date.now() / 1000) - 5 },
      },
    ])
    const card = await desk('Analyst')
    await waitFor(() => expect(within(card).getByText('Working')).toBeDefined())
    expect(within(card).getByText('Daily brief')).toBeDefined()
    expect(within(card).getByText(/attempt 2/)).toBeDefined()
  })
})
