/**
 * The real wealth API client.
 *
 * Deliberately not an `ApiRepository<T>` subclass: that base models a CRUD collection of
 * `{id}` entities, whereas the portfolio is a read-only computed snapshot with no ids and no
 * writes. It reuses the same auth header and 401 handling so session expiry behaves identically
 * across the app.
 *
 * `WealthDataSource` covers the portfolio surfaces; the journal and alert-settings calls hang off
 * the class directly, since they are not part of what a mock portfolio source needs to provide.
 */

import { API_URL } from '@/lib/api-url'
import type { WealthDataSource } from '@/pages/wealth/data-source'
import type { AlertStatus, Analysis, ManualAsset, NwPoint, PortfolioData } from '@/pages/wealth/types'

function getHeaders(): HeadersInit {
  const token = localStorage.getItem('lyra:token')
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API_URL}/${path}`, { headers: getHeaders() })
  if (res.status === 401) {
    localStorage.removeItem('lyra:token')
    localStorage.removeItem('lyra:auth')
    window.location.href = '/login'
    throw new Error('Session expired')
  }
  if (!res.ok) {
    // The surfaces show this text verbatim, so it has to name the failure, not just "error".
    throw new Error(`Failed to fetch ${path} (${res.status})`)
  }
  return res.json() as Promise<T>
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/${path}`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  })
  if (res.status === 401) {
    localStorage.removeItem('lyra:token')
    localStorage.removeItem('lyra:auth')
    window.location.href = '/login'
    throw new Error('Session expired')
  }
  if (!res.ok) {
    // The server names the offending field on a 400; surfacing that beats a generic failure.
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.error ?? `Failed to post ${path} (${res.status})`)
  }
  return res.json() as Promise<T>
}

export class ApiWealthRepository implements WealthDataSource {
  getPortfolio(): Promise<PortfolioData> {
    return get<PortfolioData>('wealth/portfolio')
  }

  getHistory(): Promise<NwPoint[]> {
    return get<NwPoint[]>('wealth/history')
  }

  getManualAssets(): Promise<ManualAsset[]> {
    return get<ManualAsset[]>('wealth/manual-assets')
  }

  /** The LLM analysis journal — latest entry per scope unless `history` is asked for. */
  async getAnalyses(): Promise<Analysis[]> {
    const body = await get<{ analyses: Analysis[] }>('wealth/analyses')
    return body.analyses ?? []
  }

  /** Alert configuration plus the live state of the background sweep. */
  getAlertStatus(): Promise<AlertStatus> {
    return get<AlertStatus>('wealth/alerts')
  }

  /**
   * Save alert overrides, answering with the new status.
   *
   * A key set to `null` is **removed**, reverting it to its environment default — which is a
   * different thing from `0`, meaning "off". The server owns that distinction; this just passes
   * the patch through unaltered.
   */
  saveAlertConfig(patch: Record<string, unknown>): Promise<AlertStatus> {
    return post<AlertStatus>('wealth/alerts/config', patch)
  }
}

export const apiWealthRepository = new ApiWealthRepository()
