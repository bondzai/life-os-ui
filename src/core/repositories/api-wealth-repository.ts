/**
 * The real wealth API client.
 *
 * Deliberately not an `ApiRepository<T>` subclass: that base models a CRUD collection of
 * `{id}` entities, whereas the portfolio is a read-only computed snapshot with no ids and no
 * writes. It reuses the same auth header and 401 handling so session expiry behaves identically
 * across the app.
 *
 * Nothing renders from this yet — the Rust endpoints are still being built. It exists so the
 * switch in `use-wealth.ts` is a one-line change rather than a rewrite.
 */

import { API_URL } from '@/lib/api-url'
import type { WealthDataSource } from '@/pages/wealth/data-source'
import type { ManualAsset, NwPoint, PortfolioData } from '@/pages/wealth/types'

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
}

export const apiWealthRepository = new ApiWealthRepository()
