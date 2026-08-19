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

/** Where the browser keeps off-chain assets. Shared with anything that writes them. */
export const MANUAL_ASSETS_KEY = 'lyra:wealth:manual-assets'

/**
 * Read the browser's off-chain asset list.
 *
 * Anything malformed is treated as an empty list rather than thrown: a corrupt entry here would
 * otherwise blank every wealth page, and these are additive to a portfolio that stands on its
 * own without them.
 */
function readManualAssets(): ManualAsset[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(MANUAL_ASSETS_KEY) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((a): a is ManualAsset => Boolean(a) && typeof a === 'object')
  } catch {
    return []
  }
}

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

  /**
   * The net-worth series.
   *
   * The endpoint answers `{group, points}` — the group is which series was asked for, and the
   * client only ever wants the default one. Unwrapping here rather than widening the interface
   * keeps `WealthDataSource` a list of series, which is what every caller actually uses.
   */
  async getHistory(): Promise<NwPoint[]> {
    const body = await get<{ group: string; points: NwPoint[] }>('wealth/history')
    return body.points ?? []
  }

  /**
   * Off-chain assets — cold storage, a Thai fund, sats on a Lightning wallet.
   *
   * **There is no endpoint for these and there should not be.** The backend is keyless by
   * design: it reads public chain data for addresses it is given, and it has no way to learn
   * that you hold gold in a drawer. `lyra-db`'s own header says the same — the keyless server
   * "can never see manual assets". So they live where the user entered them, in this browser,
   * exactly as they did in the original app.
   *
   * This is why net worth here can be lower than the number on the device you type them into.
   */
  getManualAssets(): Promise<ManualAsset[]> {
    return Promise.resolve(readManualAssets())
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
