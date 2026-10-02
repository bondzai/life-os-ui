/**
 * Search across everything you have written — entity notes and markdown files, one ranked query.
 *
 * Mirrors `lyra_db::notes`. Not `/api/search`, which despite the name proxies DuckDuckGo.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiGet, apiSend } from '@/lib/api-client'
import { useAuthStore } from '@/stores/auth-store'

export interface NoteHit {
  id: string
  /** Which store to go back to. */
  source: 'entity' | 'file'
  /** The entity id, or the path relative to the knowledge root. */
  reference: string
  title: string
  /** The matching part, with `<mark>` around the matched words. Built by FTS5, not by slicing. */
  snippet: string
  updated_at: number
  /** BM25, negated by SQLite — lower is better. The server already sorted; do not re-sort. */
  score: number
}

interface SearchResponse {
  hits: NoteHit[]
  query: string
}

/**
 * `enabled` on a non-empty query, so an empty box makes no request at all.
 *
 * `placeholderData` keeps the previous hits on screen while the next query is in flight. Without
 * it the list empties on every keystroke and the page flickers between results and nothing, which
 * reads as the search being broken rather than busy.
 */
export function useNoteSearch(query: string) {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const trimmed = query.trim()
  return useQuery<SearchResponse>({
    queryKey: ['notes', 'search', trimmed],
    enabled: isAuthenticated && trimmed !== '',
    placeholderData: (previous) => previous,
    // The index only moves every couple of minutes, so re-asking the same question inside that
    // window cannot produce a different answer.
    staleTime: 60_000,
    queryFn: () => apiGet<SearchResponse>(`notes/search?q=${encodeURIComponent(trimmed)}`),
  })
}

/** Catch the index up now rather than waiting for its clock. */
export function useReindexNotes() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () =>
      apiSend<{ indexed: number; added: number; updated: number; removed: number }>(
        'POST',
        'notes/reindex',
      ),
    onSuccess: () => client.invalidateQueries({ queryKey: ['notes', 'search'] }),
  })
}
