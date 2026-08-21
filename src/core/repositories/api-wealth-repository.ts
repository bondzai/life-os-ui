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
import type {
  AlertStatus,
  Analysis,
  ManualAsset,
  ManualAssetInput,
  NwPoint,
  PortfolioData,
} from '@/pages/wealth/types'

/** Where the browser used to keep off-chain assets. Now a queue of rows waiting to be imported. */
export const MANUAL_ASSETS_KEY = 'lyra:wealth:manual-assets'

/** Rows already accepted by the server, kept as a local backup of what was handed over. */
export const MANUAL_ASSETS_IMPORTED_KEY = 'lyra:wealth:manual-assets.imported'

/**
 * Read a stored off-chain asset list.
 *
 * Anything malformed is treated as an empty list rather than thrown: a corrupt entry here would
 * otherwise blank every wealth page, and these are additive to a portfolio that stands on its own
 * without them.
 */
function readStoredAssets(key: string): ManualAssetInput[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
    if (!Array.isArray(parsed)) return []
    return parsed.filter((a): a is ManualAssetInput => Boolean(a) && typeof a === 'object')
  } catch {
    return []
  }
}

/**
 * Hand the browser's off-chain assets to the server, once.
 *
 * **Each row is removed from the queue only after the server has accepted it**, and appended to a
 * backup key rather than dropped. That ordering is the whole design: a batch that fails halfway
 * leaves exactly the un-imported rows behind, so the next read finishes the job instead of
 * importing the first few a second time. A single "already migrated" flag could not do this — a
 * partial failure under one would either duplicate rows or lose them.
 *
 * A failure is logged and swallowed. This runs inside a read, and an unreachable import endpoint
 * must not blank the portfolio page; the rows stay queued for the next attempt.
 */
async function importLocalAssets(): Promise<void> {
  const pending = readStoredAssets(MANUAL_ASSETS_KEY)
  if (pending.length === 0) return

  const imported = readStoredAssets(MANUAL_ASSETS_IMPORTED_KEY)
  const remaining = [...pending]

  for (const asset of pending) {
    try {
      await post<ManualAsset>('wealth/manual-assets', asset)
    } catch (e) {
      console.error('Could not import an off-chain asset; it stays in this browser', e)
      break
    }
    remaining.shift()
    imported.push(asset)
    localStorage.setItem(MANUAL_ASSETS_KEY, JSON.stringify(remaining))
    localStorage.setItem(MANUAL_ASSETS_IMPORTED_KEY, JSON.stringify(imported))
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

async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_URL}/${path}`, {
    method,
    headers: getHeaders(),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (res.status === 401) {
    localStorage.removeItem('lyra:token')
    localStorage.removeItem('lyra:auth')
    window.location.href = '/login'
    throw new Error('Session expired')
  }
  if (!res.ok) {
    // The server names the offending field on a 422; surfacing that beats a generic failure.
    const detail = await res.json().catch(() => null)
    throw new Error(detail?.error ?? `Failed to ${method.toLowerCase()} ${path} (${res.status})`)
  }
  // A 204 has no body to parse — `DELETE` answers with one, and `res.json()` would throw on it.
  if (res.status === 204) return null as T
  return res.json() as Promise<T>
}

function post<T>(path: string, body: unknown): Promise<T> {
  return send<T>('POST', path, body)
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
   * These used to live only in this browser's `localStorage`, on the reasoning that a keyless
   * server cannot learn you hold gold in a drawer. True, and beside the point: it cannot learn it,
   * but it can be *told*. Keeping them client-side meant one device, no backup, gone with a
   * cleared cache — and a server-side net-worth snapshot that could never match the browser's.
   *
   * Anything still in `localStorage` is imported on the first read — see [[importLocalAssets]].
   */
  async getManualAssets(): Promise<ManualAsset[]> {
    await importLocalAssets()
    const body = await get<{ assets: ManualAsset[] }>('wealth/manual-assets')
    return body.assets ?? []
  }

  createManualAsset(input: ManualAssetInput): Promise<ManualAsset> {
    return post<ManualAsset>('wealth/manual-assets', input)
  }

  updateManualAsset(id: string, input: ManualAssetInput): Promise<ManualAsset> {
    return send<ManualAsset>('PUT', `wealth/manual-assets/${encodeURIComponent(id)}`, input)
  }

  async deleteManualAsset(id: string): Promise<void> {
    await send<null>('DELETE', `wealth/manual-assets/${encodeURIComponent(id)}`)
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
