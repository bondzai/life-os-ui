/**
 * Authenticated calls to the Lyra API, with the session handling in one place.
 *
 * These lived privately inside `api-wealth-repository.ts`, and the hooks written since re-rolled
 * their own `fetch` with a bearer header — which dropped the part that matters: an expired session
 * clearing the token and sending you to log in. The Agents page answered a stale token with
 * "the queue could not be read (401)" every five seconds instead.
 */

import { API_URL } from '@/lib/api-url'

const TOKEN_KEY = 'lyra:token'

/** The headers every authenticated request carries. */
export function authHeaders(): HeadersInit {
  const token = localStorage.getItem(TOKEN_KEY)
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

/** A 401 means the session is over, wherever it was noticed: forget it and go to the login page. */
function endSession(): never {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem('lyra:auth')
  window.location.href = '/login'
  throw new Error('Session expired')
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}/${path}`, { headers: authHeaders() })
  if (res.status === 401) endSession()
  if (!res.ok) {
    // Surfaces show this text verbatim, so it has to name the failure, not just "error".
    throw new Error(`Failed to fetch ${path} (${res.status})`)
  }
  return res.json() as Promise<T>
}

export async function apiSend<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/${path}`, {
    method,
    headers: authHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (res.status === 401) endSession()
  if (!res.ok) {
    // The server names the problem — a 422's field, a 409's state — and that beats a status code.
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.error ?? `Failed to ${method.toLowerCase()} ${path} (${res.status})`)
  }
  // A 204 has no body to parse — `DELETE` answers with one, and `res.json()` would throw on it.
  if (res.status === 204) return null as T
  return res.json() as Promise<T>
}
