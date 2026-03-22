import { Hono } from 'hono'

const searchRoutes = new Hono()

interface SearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * Web search proxy — uses DuckDuckGo HTML search (no API key needed).
 * Parses results server-side to avoid CORS issues on the frontend.
 */
searchRoutes.get('/', async (c) => {
  const query = c.req.query('q')
  if (!query) return c.json({ error: 'Missing query parameter "q"' }, 400)

  try {
    const results = await searchDDG(query)
    return c.json({ query, results })
  } catch (error) {
    console.error('Search error:', error)
    return c.json({ error: 'Search failed', results: [] }, 500)
  }
})

async function searchDDG(query: string): Promise<SearchResult[]> {
  // Use DuckDuckGo lite HTML — simple, no JS required, no API key
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Lyra/1.0 (Life OS)',
    },
  })

  if (!res.ok) throw new Error(`DDG returned ${res.status}`)

  const html = await res.text()
  return parseDDGLite(html)
}

function parseDDGLite(html: string): SearchResult[] {
  const results: SearchResult[] = []

  // DDG lite results are in table rows with class "result-link" for URLs and "result-snippet" for descriptions
  // Pattern: <a rel="nofollow" href="URL" class="result-link">TITLE</a>
  // Then: <td class="result-snippet">SNIPPET</td>

  const linkRegex = /<a[^>]*class="result-link"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi
  const snippetRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi

  const links: Array<{ url: string; title: string }> = []
  let match

  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1].replace(/&amp;/g, '&')
    const title = match[2].replace(/<[^>]*>/g, '').trim()
    if (url && title && !url.startsWith('/')) {
      links.push({ url, title })
    }
  }

  const snippets: string[] = []
  while ((match = snippetRegex.exec(html)) !== null) {
    const snippet = match[1].replace(/<[^>]*>/g, '').trim()
    if (snippet) snippets.push(snippet)
  }

  // Pair links with snippets
  for (let i = 0; i < Math.min(links.length, 8); i++) {
    results.push({
      title: links[i].title,
      url: links[i].url,
      snippet: snippets[i] ?? '',
    })
  }

  // Fallback: if regex didn't work, try simpler pattern
  if (results.length === 0) {
    const simpleRegex = /<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([^<]+)<\/a>/gi
    while ((match = simpleRegex.exec(html)) !== null && results.length < 8) {
      const url = match[1]
      const title = match[2].trim()
      if (title.length > 10 && !url.includes('duckduckgo.com')) {
        results.push({ title, url, snippet: '' })
      }
    }
  }

  return results
}

export { searchRoutes }
