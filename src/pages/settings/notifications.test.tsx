/**
 * The notification settings screen.
 *
 * Two rules are worth testing here and the rest is markup. First, **the URL field never renders a
 * stored credential** — the screen only ever gets a preview, and a field that showed the real value
 * would put a live token in the DOM. Second, **saving a webhook tests it in the same action**,
 * because a saved-but-broken webhook is the failure this screen exists to prevent.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { NotificationSettings } from './notifications'

const TOKEN_TAIL = 'wxyz'
const CHANNELS = {
  channels: [
    {
      id: 'chan-1',
      name: 'Discord · money',
      transport: 'discord',
      preview: `https://discord.com/api/webhooks/1234567890/••••${TOKEN_TAIL}`,
      stored_secret: true,
      enabled: true,
      last_error: null,
      failing_since: null,
    },
    {
      id: 'chan-2',
      name: 'Discord · system',
      transport: 'discord',
      preview: 'https://discord.com/api/webhooks/9988776/••••b1c7',
      stored_secret: true,
      enabled: true,
      last_error: '401 Unauthorized — the webhook may have been deleted in Discord',
      failing_since: Math.floor(Date.now() / 1000) - 3600,
    },
  ],
  transports: [
    { id: 'telegram', stores_credential: false },
    { id: 'discord', stores_credential: true },
  ],
}

const ROUTES = {
  routes: [
    {
      id: 'route-1',
      group: 'money',
      channel_id: 'chan-1',
      min_severity: 'warning',
      quiet_from: null,
      quiet_to: null,
    },
  ],
  groups: ['money', 'day', 'system'],
  severities: ['info', 'warning', 'critical'],
}

/** Every request the screen made, so a test can assert what it sent and in what order. */
let sent: { method: string; url: string; body: unknown }[] = []

beforeEach(() => {
  sent = []
  useAuthStore.setState({ isAuthenticated: true })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      sent.push({
        method,
        url,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      })
      if (method === 'GET' && url.endsWith('/channels')) {
        return { ok: true, json: async () => CHANNELS }
      }
      if (method === 'GET' && url.endsWith('/routes')) {
        return { ok: true, json: async () => ROUTES }
      }
      if (method === 'POST' && url.endsWith('/channels')) {
        return { ok: true, json: async () => ({ ...CHANNELS.channels[0], id: 'chan-new' }) }
      }
      return { ok: true, json: async () => ({ ok: true }) }
    }),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  useAuthStore.setState({ isAuthenticated: false })
})

/**
 * The channels list.
 *
 * Scoped, because a channel's name appears twice on this screen by design — once as a row and once
 * as a column header in the routing matrix. An unscoped `getByText` finds both.
 */
async function channelRows() {
  return within(await screen.findByRole('list')).getAllByRole('listitem')
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <NotificationSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('channels', () => {
  it('shows the preview and never puts a usable URL in an input', async () => {
    mount()
    const [money] = await channelRows()
    expect(within(money).getByText('Discord · money')).toBeDefined()

    // The preview identifies which room it is, with the token masked.
    expect(within(money).getByText(new RegExp(`••••${TOKEN_TAIL}`))).toBeDefined()

    // Open the replace form and confirm the field starts empty — the screen was never given the
    // real URL, so there is nothing it could prefill even by accident.
    fireEvent.click(screen.getAllByRole('button', { name: 'Replace URL' })[0])
    const field = await screen.findByLabelText('Webhook URL')
    expect((field as HTMLInputElement).value).toBe('')
    expect(screen.getByText(/never shown again/i)).toBeDefined()
  })

  it('says which channel is failing, and why', async () => {
    mount()
    const row = (await channelRows())[1]
    expect(within(row).getByText('Discord · system')).toBeDefined()
    expect(within(row).getByText(/failing since/)).toBeDefined()
    // The reason is the whole value of the row. A deleted webhook answers 401 forever.
    expect(within(row).getByText(/401 Unauthorized/)).toBeDefined()
  })

  it('tests a webhook in the same action that saves it', async () => {
    // A separate Test button is an invitation to skip it, and an untested webhook looks configured.
    mount()
    await channelRows()
    fireEvent.click(screen.getByRole('button', { name: 'Add a channel' }))

    fireEvent.change(await screen.findByLabelText('Webhook URL'), {
      target: { value: 'https://discord.com/api/webhooks/1/abcdefghijklmnop' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save and test' }))

    await waitFor(() => {
      const posts = sent.filter((r) => r.method === 'POST')
      expect(posts.some((r) => r.url.endsWith('/channels'))).toBe(true)
      expect(posts.some((r) => r.url.endsWith('/channels/chan-new/test'))).toBe(true)
    })
  })

  it('sends no url when only renaming, so the stored one survives', async () => {
    // Absence is the only way the form can say "leave the credential alone" — it was never given
    // the value, so it cannot send it back. Enabling is the same shape of request.
    mount()
    await channelRows()
    fireEvent.click(screen.getAllByRole('button', { name: 'Disable' })[0])

    await waitFor(() => {
      const patch = sent.find((r) => r.method === 'PATCH')
      expect(patch).toBeDefined()
      expect(patch!.body).toEqual({ enabled: false })
      expect(Object.keys(patch!.body as object)).not.toContain('url')
    })
  })
})

describe('routing', () => {
  it('saves the whole matrix, not the cell that changed', async () => {
    // A per-cell save could half-apply and leave a group delivering to a channel that had just been
    // unticked — nothing looks wrong until something arrives where it should not.
    mount()
    await screen.findByLabelText('day to Discord · money')

    fireEvent.click(screen.getByLabelText('day to Discord · money'))
    fireEvent.click(screen.getByRole('button', { name: 'Save routing' }))

    await waitFor(() => {
      const put = sent.find((r) => r.method === 'PUT' && r.url.endsWith('/routes'))
      expect(put).toBeDefined()
      const routes = (put!.body as { routes: unknown[] }).routes
      // The pre-existing money route AND the newly ticked day route.
      expect(routes).toHaveLength(2)
      expect(routes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ group: 'money', min_severity: 'warning' }),
          expect.objectContaining({ group: 'day', channel_id: 'chan-1' }),
        ]),
      )
    })
  })

  it('offers no save until something changed', async () => {
    mount()
    // `toBeDisabled` needs jest-dom, which this project does not install — the attribute is the
    // same assertion without the dependency.
    const save = await screen.findByRole('button', { name: 'Save routing' })
    expect((save as HTMLButtonElement).disabled).toBe(true)

    fireEvent.click(screen.getByLabelText('system to Discord · system'))
    const enabled = screen.getByRole('button', { name: 'Save routing' }) as HTMLButtonElement
    expect(enabled.disabled).toBe(false)
    expect(screen.getByText('unsaved changes')).toBeDefined()
  })
})
