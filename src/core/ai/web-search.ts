/**
 * Web Search Service
 *
 * Searches the web via the Lyra API backend (which proxies DuckDuckGo).
 * Falls back gracefully if the API is unavailable.
 */

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:3001/api'

export async function webSearch(query: string): Promise<SearchResult[]> {
  try {
    const res = await fetch(`${API_BASE}/search?q=${encodeURIComponent(query)}`, {
      signal: AbortSignal.timeout(10000),
    })
    if (!res.ok) return []
    const data = await res.json()
    return (data.results as SearchResult[]) ?? []
  } catch {
    return []
  }
}

/**
 * Format search results as context for LLM injection.
 */
export function formatSearchResults(results: SearchResult[]): string {
  if (results.length === 0) return 'No web results found.'
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n    ${r.url}\n    ${r.snippet}`)
    .join('\n\n')
}
