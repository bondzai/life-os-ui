/**
 * Wealth · Journal — the analysis record.
 *
 * Every AI reading of the portfolio is written here with the version it superseded, so a claim
 * made three weeks ago can be checked against what actually happened. The list shows the latest
 * entry per scope; older versions stay reachable rather than being overwritten.
 */

import { useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BookOpen, ChevronDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { EmptyState } from '@/core/components/empty-state'
import { USE_API } from '@/core/repositories'
import { apiWealthRepository } from '@/core/repositories/api-wealth-repository'
import { cn } from '@/lib/utils'
import { formatRelativeTime } from './format'
import { RowsSkeleton, WealthError } from './states'
import type { Analysis } from './types'

function AnalysisCard({ entry }: { entry: Analysis }) {
  const [open, setOpen] = useState(false)
  const hasBody = Boolean(entry.body && entry.body !== entry.summary)

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex flex-wrap items-start gap-x-3 gap-y-1.5">
          <div className="min-w-0 flex-1">
            <p className="font-medium">{entry.title ?? entry.scope}</p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <Badge variant="secondary">{entry.kind}</Badge>
              <Badge variant="outline">{entry.scope}</Badge>
              {entry.version > 1 && <Badge variant="outline">v{entry.version}</Badge>}
              {entry.archived && <Badge variant="outline">archived</Badge>}
            </div>
          </div>
          <div className="shrink-0 text-right text-xs text-muted-foreground">
            <div>{formatRelativeTime(entry.created_at)}</div>
            <div className="mt-0.5">{entry.source}</div>
          </div>
        </div>

        {entry.summary && <p className="mt-3 text-sm text-muted-foreground">{entry.summary}</p>}

        {hasBody && (
          <>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              aria-expanded={open}
              className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-muted-foreground transition hover:text-foreground"
            >
              {open ? 'Hide' : 'Read'} full analysis
              <ChevronDown className={cn('size-3.5 transition-transform', open && 'rotate-180')} />
            </button>
            {open && (
              <p className="mt-2 border-t pt-3 text-sm whitespace-pre-wrap text-muted-foreground">{entry.body}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}

export function WealthJournalPage() {
  const [filter, setFilter] = useState('')
  const {
    data: entries,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ['wealth', 'analyses'],
    queryFn: () => apiWealthRepository.getAnalyses(),
    // There is no mock journal: these are entries the AI layer actually wrote. In a demo session
    // the request would fail against a backend that is not there, so it is not made.
    enabled: USE_API,
  })

  const visible = useMemo(() => {
    const list = entries ?? []
    const needle = filter.trim().toLowerCase()
    if (!needle) return list
    return list.filter((entry) =>
      [entry.title, entry.scope, entry.kind, entry.summary]
        .filter(Boolean)
        .some((field) => (field as string).toLowerCase().includes(needle)),
    )
  }, [entries, filter])

  if (isLoading && USE_API) return <RowsSkeleton rows={4} />
  if (error) return <WealthError detail={(error as Error).message} onRetry={() => void refetch()} />

  if (!entries?.length) {
    return (
      <EmptyState
        icon={BookOpen}
        title={USE_API ? 'No analyses yet' : 'Journal needs the live backend'}
        description={
          USE_API
            ? 'Portfolio reviews written by the AI layer are recorded here, each keeping the version it replaced so you can check an old call against what happened.'
            : 'This session is running on demo data. Sign in against the API to read the analyses the AI layer has written.'
        }
      />
    )
  }

  return (
    <div className="space-y-4">
      <Input
        placeholder="Filter by title, scope or kind…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        className="max-w-sm"
      />
      {visible.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">Nothing matches “{filter}”.</p>
      ) : (
        <div className="space-y-3">
          {visible.map((entry) => (
            <AnalysisCard key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}
