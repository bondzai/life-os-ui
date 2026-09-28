/**
 * Note search.
 *
 * Four rules. **An empty box asks nothing** — no request per keystroke on a page you open all day.
 * **The snippet's `<mark>` becomes an element, never raw HTML**, because "it is only my own
 * writing" is exactly the reasoning that lets a pasted code sample execute. **Results do not empty
 * between keystrokes.** And **a hit says which store it came from**, since the two are opened in
 * different places.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { NoteSearch } from './note-search'

const NOW = Math.floor(Date.now() / 1000)

function hit(over: Record<string, unknown> = {}) {
  return {
    id: 'n-1',
    source: 'entity',
    reference: 'ent-1',
    title: 'KuCoin fees',
    snippet: 'the taker <mark>fee</mark> is 0.1%',
    updated_at: NOW - 3600,
    score: -1.2,
    ...over,
  }
}

let asked: string[] = []
let payload: unknown = { hits: [], query: '' }

beforeEach(() => {
  asked = []
  useAuthStore.setState({ isAuthenticated: true })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      asked.push(url)
      return { ok: true, json: async () => payload }
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
        <NoteSearch />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('the box', () => {
  it('asks nothing until something is typed', async () => {
    mount()
    await waitFor(() => expect(screen.getByLabelText('Search your notes')).toBeDefined())
    // This sits on a page you leave open. An empty box must cost nothing.
    expect(asked.filter((u) => u.includes('notes/search'))).toHaveLength(0)
  })

  it('asks nothing for whitespace either', async () => {
    mount()
    fireEvent.change(screen.getByLabelText('Search your notes'), { target: { value: '   ' } })
    await waitFor(() => expect(asked.filter((u) => u.includes('notes/search'))).toHaveLength(0))
  })

  it('sends the query encoded', async () => {
    payload = { hits: [hit()], query: 'taker fee' }
    mount()
    fireEvent.change(screen.getByLabelText('Search your notes'), {
      target: { value: 'taker fee & more' },
    })
    await waitFor(() => {
      const url = asked.find((u) => u.includes('notes/search'))
      expect(url).toBeDefined()
      expect(url).toContain('q=taker%20fee%20%26%20more')
    })
  })
})

describe('a hit', () => {
  it('turns the marker into an element rather than raw HTML', async () => {
    // The one place server text is rendered with markup in it. If this ever becomes
    // dangerouslySetInnerHTML, a pasted <script> in a note body becomes script on this page.
    payload = { hits: [hit()], query: 'fee' }
    mount()
    fireEvent.change(screen.getByLabelText('Search your notes'), { target: { value: 'fee' } })

    const item = await screen.findByRole('listitem')
    const marked = within(item).getByText('fee')
    expect(marked.tagName).toBe('MARK')
    // The literal tag must never appear as text, which is what a naive escape would produce.
    expect(item.textContent).not.toContain('<mark>')
    expect(item.textContent).toContain('the taker fee is 0.1%')
  })

  it('does not execute markup that arrives inside a snippet', async () => {
    payload = {
      hits: [hit({ snippet: 'before <img src=x onerror=alert(1)> after' })],
      query: 'x',
    }
    mount()
    fireEvent.change(screen.getByLabelText('Search your notes'), { target: { value: 'x' } })

    const item = await screen.findByRole('listitem')
    expect(item.querySelector('img')).toBeNull()
    expect(item.textContent).toContain('<img src=x onerror=alert(1)>')
  })

  it('says which store it came from', async () => {
    payload = {
      hits: [hit({ id: 'n-2', source: 'file', reference: 'wealth/exchanges.md' })],
      query: 'fee',
    }
    mount()
    fireEvent.change(screen.getByLabelText('Search your notes'), { target: { value: 'fee' } })
    const item = await screen.findByRole('listitem')
    // An entity note and a markdown file are opened in different places.
    expect(within(item).getByText(/wealth\/exchanges\.md/)).toBeDefined()
  })

  it('keeps the previous results on screen while the next query is in flight', async () => {
    payload = { hits: [hit()], query: 'fee' }
    mount()
    const box = screen.getByLabelText('Search your notes')
    fireEvent.change(box, { target: { value: 'fee' } })
    await screen.findByRole('listitem')

    // A list that blanks on every letter reads as broken rather than busy.
    fireEvent.change(box, { target: { value: 'fees' } })
    expect(screen.getByRole('listitem')).toBeDefined()
  })

  it('says so when nothing matches', async () => {
    payload = { hits: [], query: 'zzz' }
    mount()
    fireEvent.change(screen.getByLabelText('Search your notes'), { target: { value: 'zzz' } })
    expect(await screen.findByText(/Nothing matches/)).toBeDefined()
  })
})
