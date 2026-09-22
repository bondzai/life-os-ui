/**
 * The agent fleet, live, over a socket that expects to be broken.
 *
 * A WebSocket in a personal app spends most of its life in adverse conditions: a laptop lid comes
 * down, a phone switches from wifi to cellular, the server restarts during a deploy. None of those
 * raise an error on the socket — a dead TCP connection looks exactly like a quiet one until you
 * try to write. So "robust" here is four specific things, not a vibe:
 *
 * 1. **Reconnect with backoff and jitter.** A server that just restarted must not be met by every
 *    open tab at the same instant. Delay doubles to a ceiling and carries ±25% jitter.
 * 2. **A watchdog, not a hope.** The server pings every 20s. If nothing — ping, frame, anything —
 *    arrives inside {@link SILENCE_MS}, we treat the socket as dead and reconnect, because the
 *    alternative is a page that looks connected and is an hour stale.
 * 3. **Reconnect on the events the browser gives us.** Coming back from background or regaining
 *    the network resets the backoff and retries immediately; waiting out a 30s timer after the
 *    user has visibly returned is the difference between "live" and "eventually".
 * 4. **Degrade rather than go blank.** After {@link FALLBACK_AFTER} failures the hook polls the
 *    REST snapshot instead. A second late beats an empty page, and the socket keeps trying
 *    underneath.
 *
 * The protocol is snapshot-then-deltas, and every frame is idempotent — applying one twice is the
 * same as applying it once — so a reconnect never needs to replay anything. That is what keeps
 * recovery from being its own source of bugs.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { API_URL } from '@/lib/api-url'
import { apiGet, apiSend } from '@/lib/api-client'

export type AgentStatus = 'idle' | 'working'

export interface CurrentJob {
  id: string
  kind: string
  attempt: number
  started_at: number
}

export interface Agent {
  id: string
  lane: string
  status: AgentStatus
  job?: CurrentJob
  last_seen: number
  done: number
  failed: number
}

type Frame =
  | { type: 'snapshot'; agents: Agent[]; at: number }
  | { type: 'agent'; agent: Agent }
  | { type: 'gone'; id: string }

/** How the page describes its own connection, which is information the user is entitled to. */
export type Link = 'connecting' | 'live' | 'retrying' | 'polling'

const FIRST_RETRY_MS = 500
const MAX_RETRY_MS = 15_000
/** Server pings every 20s; three missed beats is dead rather than slow. */
const SILENCE_MS = 65_000
/** Failures before the socket stops being the only plan. */
const FALLBACK_AFTER = 3

function backoff(attempt: number): number {
  const flat = Math.min(FIRST_RETRY_MS * 2 ** attempt, MAX_RETRY_MS)
  // ±25%, so a restart does not gather every tab into one thundering reconnect.
  return flat * (0.75 + Math.random() * 0.5)
}

/** `http://host/api` → `ws://host/api`, keeping the page's own scheme and host. */
function socketUrl(ticket: string): string {
  const base = API_URL.startsWith('/') ? `${window.location.origin}${API_URL}` : API_URL
  const url = new URL(`${base.replace(/\/$/, '')}/agents/stream`)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('ticket', ticket)
  return url.toString()
}

export function useAgentStream(enabled = true) {
  const [agents, setAgents] = useState<Agent[]>([])
  const [link, setLink] = useState<Link>('connecting')

  const socket = useRef<WebSocket | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const watchdog = useRef<ReturnType<typeof setTimeout> | null>(null)
  const attempts = useRef(0)
  // Survives re-renders and closures; the connect loop reads it to know whether to keep going.
  const live = useRef(true)

  const apply = useCallback((frame: Frame) => {
    setAgents((current) => {
      if (frame.type === 'snapshot') return frame.agents
      if (frame.type === 'gone') return current.filter((a) => a.id !== frame.id)
      // Matched explicitly, not by elimination. A frame from a newer server has a `type` this
      // build has never heard of, and reaching `frame.agent.id` on it throws inside a state
      // updater — which takes the whole page down, for the one case the tagged protocol exists
      // to survive. Unknown means ignored.
      if (frame.type !== 'agent' || !frame.agent?.id) return current
      const next = current.filter((a) => a.id !== frame.agent.id)
      next.push(frame.agent)
      // Sorted here rather than in the component so the list never reorders under the cursor for
      // a reason the reader cannot see.
      return next.sort((a, b) => a.id.localeCompare(b.id))
    })
  }, [])

  useEffect(() => {
    if (!enabled) return
    live.current = true

    /** Any traffic at all resets the clock; silence past SILENCE_MS is a dead socket. */
    const heard = () => {
      if (watchdog.current) clearTimeout(watchdog.current)
      watchdog.current = setTimeout(() => {
        // `close()` rather than reconnecting directly, so there is exactly one path back in.
        socket.current?.close()
      }, SILENCE_MS)
    }

    const poll = async () => {
      try {
        const { agents } = await apiGet<{ agents: Agent[] }>('agents')
        apply({ type: 'snapshot', agents, at: 0 })
      } catch {
        // The socket is already retrying; a failed poll needs no separate alarm.
      }
    }

    const connect = async () => {
      if (!live.current) return
      try {
        // The JWT buys a ticket over an ordinary authenticated POST; only the ticket goes in the
        // URL, because a query string is logged and a JWT in a log is a session anyone can take.
        const { ticket } = await apiSend<{ ticket: string }>('POST', 'agents/ticket')
        if (!live.current) return

        const ws = new WebSocket(socketUrl(ticket))
        socket.current = ws

        ws.onopen = () => {
          attempts.current = 0
          setLink('live')
          heard()
        }
        ws.onmessage = (event) => {
          heard()
          try {
            apply(JSON.parse(event.data) as Frame)
          } catch {
            // A frame this client cannot parse is a newer server, not a broken one. Ignoring it
            // is the whole reason frames are tagged.
          }
        }
        ws.onerror = () => ws.close()
        ws.onclose = () => {
          socket.current = null
          failed()
        }
      } catch {
        failed()
      }
    }

    /**
     * One path back in, whichever way the attempt failed — a refused ticket or a socket that
     * closed. It was written out twice, and two copies of a retry policy is how one of them ends
     * up with a different threshold.
     */
    function failed() {
      if (!live.current) return
      attempts.current += 1
      const degraded = attempts.current >= FALLBACK_AFTER
      setLink(degraded ? 'polling' : 'retrying')
      if (degraded) void poll()
      retryTimer.current = setTimeout(connect, backoff(attempts.current))
    }

    void connect()

    // The browser knows things a timer cannot: the tab is visible again, the network is back.
    // Both reset the backoff, because the reason for waiting has just gone away.
    const retryNow = () => {
      if (!live.current || socket.current) return
      attempts.current = 0
      if (retryTimer.current) clearTimeout(retryTimer.current)
      void connect()
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') retryNow()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('online', retryNow)

    return () => {
      live.current = false
      if (retryTimer.current) clearTimeout(retryTimer.current)
      if (watchdog.current) clearTimeout(watchdog.current)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('online', retryNow)
      socket.current?.close()
      socket.current = null
    }
  }, [enabled, apply])

  return { agents, link }
}

