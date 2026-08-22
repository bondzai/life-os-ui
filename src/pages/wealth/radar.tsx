/**
 * Radar — valuation & mood models. The "look up and out" panel.
 *
 * Everything else on these surfaces answers *what do I hold*. This one answers *what is the
 * market doing*, from a keyless read of public sources: Fear & Greed, MVRV Z-Score, the BTC
 * rainbow band, SOPR and the Puell Multiple.
 *
 * **Not advice, and deliberately not acted on anywhere.** No alert fires off these numbers and no
 * tier is assigned from them; they are context for a person, which is why the panel says so.
 *
 * Each model is a separate upstream read, so each is optional — one being down leaves a shorter
 * list rather than an error.
 */

import { useQuery } from '@tanstack/react-query'
import { Radar as RadarIcon } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { USE_API } from '@/core/repositories'
import { apiWealthRepository } from '@/core/repositories/api-wealth-repository'
import { formatRelativeTime } from './format'
import { RowsSkeleton, WealthError } from './states'
import { gauges } from './radar-gauges'

export function RadarPanel() {
  const sentiment = useQuery({
    queryKey: ['wealth', 'sentiment'],
    queryFn: () => apiWealthRepository.getSentiment(),
    // Public market data, not the user's book: an hour of staleness is generous and still fresh
    // enough for a panel whose whole point is the slow view.
    staleTime: 60 * 60 * 1000,
    enabled: USE_API,
    retry: false,
  })

  // A demo session has no mock for this, and inventing market readings would be worse than
  // saying nothing — a fabricated "Greed" is indistinguishable from a real one.
  if (!USE_API) return null

  const rows = gauges(sentiment.data)

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <div className="flex items-center gap-2">
          <RadarIcon className="size-4 text-muted-foreground" />
          <div>
            <CardTitle className="text-sm font-medium">Radar</CardTitle>
            <p className="text-xs text-muted-foreground">Valuation &amp; mood models · not advice</p>
          </div>
        </div>
        {sentiment.data?.fetched_at && (
          <span className="text-xs text-muted-foreground">
            {formatRelativeTime(sentiment.data.fetched_at)}
          </span>
        )}
      </CardHeader>
      <CardContent>
        {sentiment.isLoading && <RowsSkeleton rows={5} />}
        {sentiment.error && (
          <WealthError
            detail={(sentiment.error as Error).message}
            onRetry={() => void sentiment.refetch()}
          />
        )}
        {!sentiment.isLoading && !sentiment.error && rows.length === 0 && (
          <p className="py-3 text-sm text-muted-foreground">
            No models answered — these are keyless reads of public sources, so this is usually an
            upstream being down rather than anything about your book.
          </p>
        )}

        <div className="divide-y">
          {rows.map((row) => (
            <div key={row.key} className="py-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-sm">{row.title}</span>
                <span className="flex items-baseline gap-2">
                  <span className="text-xs text-muted-foreground">{row.label}</span>
                  <span className="text-sm font-medium tabular-nums">{row.value}</span>
                </span>
              </div>
              <div
                className="mt-1 h-1 w-full overflow-hidden rounded-full bg-muted"
                role="img"
                aria-label={`${row.title}: ${row.value}, ${row.label}`}
              >
                <div
                  className="h-full rounded-full"
                  style={{ width: `${Math.max(2, row.frac * 100)}%`, backgroundColor: row.color }}
                />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}
