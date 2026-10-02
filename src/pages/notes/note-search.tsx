/**
 * Search across everything you have written.
 *
 * Self-contained so it mounts into the notes page with one line, the way `WaitingOnYou` mounts
 * into Today. That page is 1,200 lines; adding a feature to it should not mean editing it.
 *
 * Three things the markup is built around:
 *
 * **The snippet comes from FTS5 with `<mark>` already in it.** That is the one place this renders
 * server-provided HTML, so it is inserted as text nodes split on the marker rather than through
 * `dangerouslySetInnerHTML` — the note body is yours, but "it is my own data" is exactly the
 * reasoning that puts an injection in a personal tool.
 *
 * **Results do not empty between keystrokes.** The hook keeps the previous page while the next is
 * in flight; a list that blanks on every letter reads as broken rather than busy.
 *
 * **Where a hit lives is shown.** An entity note and a markdown file are opened in different
 * places, so the row says which it is instead of pretending they are one thing.
 */

import { useState } from 'react'
import { FileText, Loader2, NotebookPen, RefreshCw, Search } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatRelativeTime } from '@/pages/wealth/format'
import { useNoteSearch, useReindexNotes, type NoteHit } from '@/core/hooks/use-note-search'

export function NoteSearch() {
  const [query, setQuery] = useState('')
  const results = useNoteSearch(query)
  const reindex = useReindexNotes()
  const hits = results.data?.hits ?? []
  const searching = query.trim() !== ''

  return (
    <section className="space-y-3" aria-labelledby="note-search">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <input
            id="note-search"
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search everything you have written"
            aria-label="Search your notes"
            className="w-full rounded-md border bg-background py-2 pr-3 pl-9 text-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => reindex.mutate()}
          disabled={reindex.isPending}
          title="The index catches up on its own every couple of minutes. This does it now."
        >
          <RefreshCw
            className={`size-3.5 ${reindex.isPending ? 'animate-spin' : ''}`}
            aria-hidden
          />
          Reindex
        </Button>
      </div>

      {reindex.data && (
        <p className="text-xs text-muted-foreground">
          {reindex.data.indexed} indexed
          {reindex.data.added > 0 && ` · ${reindex.data.added} new`}
          {reindex.data.updated > 0 && ` · ${reindex.data.updated} changed`}
          {reindex.data.removed > 0 && ` · ${reindex.data.removed} gone`}
        </p>
      )}

      {results.isError && (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {results.error.message}
        </p>
      )}

      {searching && (
        <>
          {results.isFetching && hits.length === 0 ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden />
              Searching…
            </p>
          ) : hits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nothing matches &ldquo;{query.trim()}&rdquo;.
            </p>
          ) : (
            <ul className="space-y-2">
              {hits.map((hit) => (
                <Hit key={hit.id} hit={hit} />
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  )
}

function Hit({ hit }: { hit: NoteHit }) {
  const Icon = hit.source === 'file' ? FileText : NotebookPen
  return (
    <li className="rounded-md border p-3">
      <p className="flex items-center gap-2 font-medium">
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="truncate">{hit.title || hit.reference}</span>
      </p>
      <p className="mt-1 text-sm text-muted-foreground">
        <Marked snippet={hit.snippet} />
      </p>
      <p className="mt-1.5 font-mono text-xs text-muted-foreground">
        {hit.source === 'file' ? hit.reference : 'note'} · {formatRelativeTime(hit.updated_at)}
      </p>
    </li>
  )
}

/**
 * Render FTS5's snippet, with the matched words emphasised.
 *
 * Split on the markers and build text nodes. `dangerouslySetInnerHTML` would be one line shorter
 * and would render whatever a note body happens to contain — and "it is only my own writing" is
 * precisely the reasoning that lets a pasted code sample become script in a personal tool.
 */
function Marked({ snippet }: { snippet: string }) {
  const parts = snippet.split(/<mark>|<\/mark>/)
  return (
    <>
      {parts.map((part, index) =>
        // Odd indices are what sat between the markers, so they are the matches.
        index % 2 === 1 ? (
          <mark key={index} className="rounded-sm bg-amber-500/25 px-0.5 text-inherit">
            {part}
          </mark>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </>
  )
}
