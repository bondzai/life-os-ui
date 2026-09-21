/**
 * The command palette, which is now the only way into capture.
 *
 * It replaced two other surfaces — a ⌘⇧I dialog and a `/` bar on two pages — so the mode rules
 * are the contract: a prefix creates, bare text searches, and `/ask` is neither. Getting that
 * wrong does not throw, it silently files a question as a note, which is why it is pinned here.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { useUiStore } from '@/stores/ui-store'
import { CommandBar } from './command-bar'

async function open(seed = '') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <CommandBar />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  useUiStore.getState().openCommandBar(seed)
  // The dialog portals in on the next tick, so every test waits for the field before touching it.
  await screen.findByPlaceholderText(/Search, or/)
  return view
}

function field() {
  return screen.getByPlaceholderText(/Search, or/)
}

function type(text: string) {
  fireEvent.change(field(), { target: { value: text } })
}

beforeEach(() => {
  useAuthStore.setState({ isAuthenticated: true })
})

afterEach(() => {
  useAuthStore.setState({ isAuthenticated: false })
  useUiStore.setState({ commandBarOpen: false, commandBarSeed: '' })
})

describe('CommandBar', () => {
  it('teaches the prefixes when it is empty, rather than showing a blank box', async () => {
    await open()
    expect(await screen.findByText('search everything')).toBeDefined()
    expect(screen.getByText('a task')).toBeDefined()
  })

  it('opens seeded, so a shortcut can ask for capture mode without a second dialog', async () => {
    await open('/')
    await waitFor(() => expect((field() as HTMLInputElement).value).toBe('/'))
    // A bare slash offers the whole menu.
    expect(screen.getByText('/task')).toBeDefined()
    expect(screen.getByText('/habit')).toBeDefined()
  })

  it('reserves /ask ahead of the capture protocol', async () => {
    await open()
    type('/ask ')
    // Not "Enter to capture as Note" — a question must never be filed as one.
    expect(await screen.findByText(/Press Enter to ask Lyra/)).toBeDefined()
  })

  it('names what Enter will do before it is pressed', async () => {
    await open()
    type('! ship the thing')
    // `!` is the task prefix, and the mode is stated rather than left to be discovered by
    // pressing Enter and reading what came out.
    await waitFor(() => expect(screen.getAllByText('Task').length).toBeGreaterThan(0))
    expect(screen.getByText(/Enter to capture as/)).toBeDefined()
  })

  it('captures on Enter and stays open for the next thought', async () => {
    await open()
    type('* dashboard redesign')
    fireEvent.keyDown(field(), { key: 'Enter' })

    // Confirmation in place of a toast, because the palette is covering the screen.
    await waitFor(() => expect(screen.getByText(/dashboard redesign/)).toBeDefined())
    expect(screen.getByText(/Captured/)).toBeDefined()
    // Cleared, not closed: thoughts arrive in bursts.
    expect((field() as HTMLInputElement).value).toBe('')
  })

  it('searches on bare text instead of capturing it', async () => {
    await open()
    type('task')
    // The Tasks module, found — not an entity called "task" created.
    await waitFor(() => expect(screen.getByText('Navigation')).toBeDefined())
    expect(screen.queryByText(/Enter to capture as/)).toBeNull()
  })
})
