/**
 * The socket's behaviour when things go wrong, which is the only behaviour worth testing.
 *
 * A happy-path WebSocket test proves almost nothing — the hard part was never receiving a frame on
 * an open connection. What breaks in practice is the recovery: a reconnect storm after a restart,
 * a socket that died silently and a page that still says "live", a tab that comes back from
 * background and waits thirty seconds for a timer.
 */

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStream } from './use-agent-stream'

/** A WebSocket that does nothing until a test tells it to. */
class FakeSocket {
  static live: FakeSocket[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  closed = false
  url: string

  constructor(url: string) {
    // Declared and assigned rather than a parameter property: `erasableSyntaxOnly` is on, and
    // that shorthand emits runtime code.
    this.url = url
    FakeSocket.live.push(this)
  }

  close() {
    if (this.closed) return
    this.closed = true
    this.onclose?.()
  }

  open() {
    this.onopen?.()
  }

  send(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }

  static get latest() {
    return FakeSocket.live[FakeSocket.live.length - 1]
  }
}

const AGENT = {
  id: 'deliver-0@4242',
  lane: 'deliver',
  status: 'idle' as const,
  last_seen: 1_700_000_000,
  done: 0,
  failed: 0,
}

beforeEach(() => {
  FakeSocket.live = []
  vi.stubGlobal('WebSocket', FakeSocket)
  localStorage.setItem('lyra:token', 'a-token')
  // The ticket exchange, which every connect attempt begins with.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, json: async () => ({ ticket: 'tkt', agents: [] }) })),
  )
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  localStorage.clear()
})

describe('useAgentStream', () => {
  it('spends a ticket in the URL and never the JWT', async () => {
    renderHook(() => useAgentStream())
    await waitFor(() => expect(FakeSocket.latest).toBeDefined())

    const url = FakeSocket.latest.url
    expect(url).toContain('ticket=tkt')
    // The whole reason the ticket exists: a query string is logged, and a logged JWT is a session
    // anyone who reads the log can take.
    expect(url).not.toContain('a-token')
    expect(url).toMatch(/^ws:/)
  })

  it('applies a snapshot and then deltas on top of it', async () => {
    const { result } = renderHook(() => useAgentStream())
    await waitFor(() => expect(FakeSocket.latest).toBeDefined())

    act(() => {
      FakeSocket.latest.open()
      FakeSocket.latest.send({ type: 'snapshot', agents: [AGENT], at: 1 })
    })
    await waitFor(() => expect(result.current.agents).toHaveLength(1))
    expect(result.current.link).toBe('live')

    act(() => {
      FakeSocket.latest.send({
        type: 'agent',
        agent: { ...AGENT, status: 'working', job: { id: 'j1', kind: 'deliver.telegram', attempt: 1, started_at: 2 } },
      })
    })
    await waitFor(() => expect(result.current.agents[0].status).toBe('working'))

    act(() => {
      FakeSocket.latest.send({ type: 'gone', id: AGENT.id })
    })
    await waitFor(() => expect(result.current.agents).toHaveLength(0))
  })

  it('replaces rather than duplicates when an agent reports twice', async () => {
    const { result } = renderHook(() => useAgentStream())
    await waitFor(() => expect(FakeSocket.latest).toBeDefined())

    act(() => {
      FakeSocket.latest.open()
      FakeSocket.latest.send({ type: 'agent', agent: AGENT })
      FakeSocket.latest.send({ type: 'agent', agent: { ...AGENT, done: 1 } })
    })

    // Every frame is idempotent, which is what lets a reconnect skip replaying anything.
    await waitFor(() => expect(result.current.agents).toHaveLength(1))
    expect(result.current.agents[0].done).toBe(1)
  })

  it('ignores a frame it does not understand instead of dying on it', async () => {
    const { result } = renderHook(() => useAgentStream())
    await waitFor(() => expect(FakeSocket.latest).toBeDefined())

    act(() => {
      FakeSocket.latest.open()
      FakeSocket.latest.send({ type: 'snapshot', agents: [AGENT], at: 1 })
      FakeSocket.latest.onmessage?.({ data: 'not json at all' })
      FakeSocket.latest.onmessage?.({ data: JSON.stringify({ type: 'from_a_newer_server' }) })
    })

    // A tagged protocol exists so an old client survives a new server.
    await waitFor(() => expect(result.current.agents).toHaveLength(1))
    expect(result.current.link).toBe('live')
  })

  it('reconnects after a drop, and says so while it is trying', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useAgentStream())
    await vi.waitFor(() => expect(FakeSocket.latest).toBeDefined())

    act(() => FakeSocket.latest.open())
    expect(result.current.link).toBe('live')

    act(() => FakeSocket.latest.close())
    expect(result.current.link).toBe('retrying')

    const before = FakeSocket.live.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000)
    })
    expect(FakeSocket.live.length).toBeGreaterThan(before)
  })

  it('falls back to polling rather than going blank', async () => {
    vi.useFakeTimers()
    const { result } = renderHook(() => useAgentStream())
    await vi.waitFor(() => expect(FakeSocket.latest).toBeDefined())

    // Three failures is the threshold; a second late beats an empty page.
    for (let i = 0; i < 3; i++) {
      act(() => FakeSocket.latest.close())
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000)
      })
    }
    expect(result.current.link).toBe('polling')
  })

  it('treats silence as death, because a dead socket looks exactly like a quiet one', async () => {
    vi.useFakeTimers()
    renderHook(() => useAgentStream())
    await vi.waitFor(() => expect(FakeSocket.latest).toBeDefined())

    const first = FakeSocket.latest
    act(() => first.open())

    // The server pings every 20s. Past the watchdog with nothing heard, this socket is gone —
    // the failure mode being closed here is a page that looks connected and is an hour stale.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(70_000)
    })
    expect(first.closed).toBe(true)
  })

  it('closes the socket on unmount rather than leaking it', async () => {
    const { unmount } = renderHook(() => useAgentStream())
    await waitFor(() => expect(FakeSocket.latest).toBeDefined())
    const socket = FakeSocket.latest

    unmount()
    expect(socket.closed).toBe(true)
  })
})
