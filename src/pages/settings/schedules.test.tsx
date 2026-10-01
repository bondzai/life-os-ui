/**
 * The schedules screen.
 *
 * Three rules are worth testing and the rest is markup. **A missed firing is visible**, because a
 * schedule that silently stopped is the whole reason this screen exists. **The form sends minutes,
 * not a clock string**, since that conversion is the one place a 09:00 can become 9 minutes past
 * midnight. And **a weekly schedule with no days cannot be submitted**, because it would be a row
 * that never fires and never says why.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuthStore } from '@/stores/auth-store'
import { ScheduleSettings } from './schedules'

const CRONS = {
  crons: [
    {
      id: 'cron-1',
      name: 'Stand up',
      schedule: { kind: 'daily', at_minute: 570 },
      describes: 'every day at 09:30',
      action: 'notify.message',
      payload: { text: 'Stand up and stretch', group: 'day' },
      enabled: true,
      catch_up_minutes: 60,
      last_occurrence: '2026-09-27T09:30',
      last_fired_at: Math.floor(Date.now() / 1000) - 600,
      missed: 0,
      last_missed_at: null,
    },
    {
      id: 'cron-2',
      name: 'Weekly review',
      schedule: { kind: 'weekly', days: [6], at_minute: 1080 },
      describes: 'Sun at 18:00',
      action: 'notify.message',
      payload: { text: 'Close the week', group: 'day' },
      enabled: false,
      catch_up_minutes: 240,
      last_occurrence: null,
      last_fired_at: null,
      missed: 3,
      last_missed_at: Math.floor(Date.now() / 1000) - 86400,
    },
  ],
  actions: ['notify.message', 'wealth.defi'],
  groups: ['money', 'day', 'system'],
}

/** Every request the screen made, so a test can assert what it sent. */
let sent: { method: string; url: string; body: unknown }[] = []

beforeEach(() => {
  sent = []
  useAuthStore.setState({ isAuthenticated: true })
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      sent.push({ method, url, body: init?.body ? JSON.parse(init.body as string) : undefined })
      if (method === 'GET') return { ok: true, json: async () => CRONS }
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
        <ScheduleSettings />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function rows() {
  return within(await screen.findByRole('list')).getAllByRole('listitem')
}

describe('the list', () => {
  it('says what a schedule does and when it last ran', async () => {
    mount()
    const [standUp] = await rows()
    expect(within(standUp).getByText('Stand up')).toBeDefined()
    expect(within(standUp).getByText(/every day at 09:30/)).toBeDefined()
    expect(within(standUp).getByText(/Stand up and stretch/)).toBeDefined()
    expect(within(standUp).getByText(/last ran/)).toBeDefined()
  })

  it('shows missed firings rather than leaving them in the log', async () => {
    // The failure this screen exists for: the box was off, nothing arrived, and without this the
    // only trace is a tracing::warn nobody reads.
    mount()
    const review = (await rows())[1]
    expect(within(review).getByText(/3 missed/)).toBeDefined()
    expect(within(review).getByText(/catch-up window/)).toBeDefined()
    // And a disabled row says so, because "off" and "broken" look identical otherwise.
    expect(within(review).getByText('off')).toBeDefined()
    expect(within(review).getByRole('button', { name: 'Enable' })).toBeDefined()
  })

  it('has not run yet reads differently from never firing again', async () => {
    mount()
    const review = (await rows())[1]
    expect(within(review).getByText('has not run yet')).toBeDefined()
  })
})

describe('adding one', () => {
  it('sends minutes past midnight, not the clock string', async () => {
    // The one conversion in this screen. Get it wrong and a 09:00 nudge arrives at 00:09.
    mount()
    await rows()
    fireEvent.click(screen.getByRole('button', { name: 'Add a schedule' }))

    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Water' } })
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Drink water' } })
    fireEvent.change(screen.getByLabelText('At'), { target: { value: '07:45' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add schedule' }))

    await waitFor(() => {
      const post = sent.find((r) => r.method === 'POST')
      expect(post).toBeDefined()
      expect(post!.body).toEqual({
        name: 'Water',
        schedule: { kind: 'daily', at_minute: 7 * 60 + 45 },
        action: 'notify.message',
        payload: { text: 'Drink water', group: 'day' },
        catch_up_minutes: 60,
      })
    })
  })

  it('will not submit a weekly schedule with no days', async () => {
    // It would be a row that never fires, and the row itself would look fine.
    mount()
    await rows()
    fireEvent.click(screen.getByRole('button', { name: 'Add a schedule' }))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Review' } })
    fireEvent.change(screen.getByLabelText('Message'), { target: { value: 'Close the week' } })
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'weekly' } })

    // Untick the five weekdays the form starts with.
    for (const day of ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']) {
      fireEvent.click(screen.getByRole('button', { name: day }))
    }

    const save = screen.getByRole('button', { name: 'Add schedule' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    expect(screen.getByText(/Pick at least one day/)).toBeDefined()

    // And it becomes submittable the moment a day is chosen — a disabled button with no way out is
    // worse than no button.
    fireEvent.click(screen.getByRole('button', { name: 'Sat' }))
    expect((screen.getByRole('button', { name: 'Add schedule' }) as HTMLButtonElement).disabled).toBe(
      false,
    )
  })

  it('needs a name and a message before it will send anything', async () => {
    mount()
    await rows()
    fireEvent.click(screen.getByRole('button', { name: 'Add a schedule' }))
    await screen.findByLabelText('Name')
    expect((screen.getByRole('button', { name: 'Add schedule' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
    expect(sent.filter((r) => r.method === 'POST')).toHaveLength(0)
  })
})

describe('running one by hand', () => {
  it('posts to the run endpoint and leaves the schedule alone', async () => {
    // Safe to press while testing: the scheduled firing is a different job with a different key, so
    // this must not be a PATCH of any kind.
    mount()
    const [standUp] = await rows()
    fireEvent.click(within(standUp).getByRole('button', { name: 'Run now' }))

    await waitFor(() => {
      const post = sent.find((r) => r.method === 'POST')
      expect(post).toBeDefined()
      expect(post!.url.endsWith('/crons/cron-1/run')).toBe(true)
    })
    expect(sent.some((r) => r.method === 'PATCH')).toBe(false)
  })

  it('toggles enabled with a patch carrying only that field', async () => {
    mount()
    const review = (await rows())[1]
    fireEvent.click(within(review).getByRole('button', { name: 'Enable' }))

    await waitFor(() => {
      const patch = sent.find((r) => r.method === 'PATCH')
      expect(patch).toBeDefined()
      expect(patch!.url.endsWith('/crons/cron-2')).toBe(true)
      expect(patch!.body).toEqual({ enabled: true })
    })
  })
})

describe('an action that fetches', () => {
  it('asks for no message, and sends an empty payload', async () => {
    // `wealth.defi` reads the chains. There is nothing for a person to type, so requiring a
    // message would make the form unsubmittable.
    mount()
    await rows()
    fireEvent.click(screen.getByRole('button', { name: 'Add a schedule' }))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'DeFi check' } })
    fireEvent.change(screen.getByLabelText('What it does'), {
      target: { value: 'wealth.defi' },
    })

    expect(screen.queryByLabelText('Message')).toBeNull()
    fireEvent.change(screen.getByLabelText('When'), { target: { value: 'every' } })
    fireEvent.change(screen.getByLabelText('Minutes apart'), { target: { value: '10' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add schedule' }))

    await waitFor(() => {
      const post = sent.find((r) => r.method === 'POST')
      expect(post).toBeDefined()
      expect(post!.body).toEqual({
        name: 'DeFi check',
        schedule: { kind: 'every', seconds: 600 },
        action: 'wealth.defi',
        payload: { currency: 'usd' },
        catch_up_minutes: 60,
      })
    })
  })

  it('offers a currency, and sends the one chosen', async () => {
    mount()
    await rows()
    fireEvent.click(screen.getByRole('button', { name: 'Add a schedule' }))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'DeFi in baht' } })
    fireEvent.change(screen.getByLabelText('What it does'), { target: { value: 'wealth.defi' } })
    fireEvent.change(screen.getByLabelText('Reported in'), { target: { value: 'thb' } })
    fireEvent.click(screen.getByRole('button', { name: 'Add schedule' }))

    await waitFor(() => {
      const post = sent.find((r) => r.method === 'POST')
      expect(post).toBeDefined()
      expect((post!.body as { payload: unknown }).payload).toEqual({ currency: 'thb' })
    })
  })

  it('offers no currency for an action that sends text', async () => {
    // notify.message has no money in it; a currency picker there is a control that does nothing.
    mount()
    await rows()
    fireEvent.click(screen.getByRole('button', { name: 'Add a schedule' }))
    await screen.findByLabelText('Name')
    expect(screen.queryByLabelText('Reported in')).toBeNull()
  })

  it('still requires a message for an action that sends one', async () => {
    mount()
    await rows()
    fireEvent.click(screen.getByRole('button', { name: 'Add a schedule' }))
    fireEvent.change(await screen.findByLabelText('Name'), { target: { value: 'Stand up' } })
    // notify.message is the default, so the message field is there and the form is not ready.
    expect(screen.getByLabelText('Message')).toBeDefined()
    expect((screen.getByRole('button', { name: 'Add schedule' }) as HTMLButtonElement).disabled).toBe(
      true,
    )
  })
})
