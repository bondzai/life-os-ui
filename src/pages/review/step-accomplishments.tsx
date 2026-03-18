import { useMemo } from 'react'
import { Trophy, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { Entity } from '@/core/types'

interface StepAccomplishmentsProps {
  items: Entity[]
  allEntities?: Entity[]
}

export function StepAccomplishments({ items, allEntities }: StepAccomplishmentsProps) {
  const lastWeekCount = useMemo(() => {
    if (!allEntities) return undefined
    const now = new Date()
    const thisWeekStart = new Date(now)
    thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay())
    thisWeekStart.setHours(0, 0, 0, 0)
    const lastWeekStart = new Date(thisWeekStart)
    lastWeekStart.setDate(lastWeekStart.getDate() - 7)
    const lwStart = lastWeekStart.toISOString().split('T')[0]
    const lwEnd = thisWeekStart.toISOString().split('T')[0]

    return allEntities.filter(
      (e) =>
        (e.type === 'task' || e.type === 'goal') &&
        e.status === 'done' &&
        e.updatedAt.split('T')[0] >= lwStart &&
        e.updatedAt.split('T')[0] < lwEnd,
    ).length
  }, [allEntities])

  const delta = lastWeekCount != null ? items.length - lastWeekCount : undefined

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Trophy className="h-4 w-4 text-yellow-500" />
          Accomplishments this week
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No completed tasks or goals this week. That's okay — every week is different.
          </p>
        ) : (
          <div className="space-y-3">
            {/* Top 3 highlights */}
            {items.length > 0 && (
              <div className="grid gap-2 sm:grid-cols-3">
                {items.slice(0, 3).map((item) => (
                  <div
                    key={item.id}
                    className="rounded-lg border bg-green-50/50 dark:bg-green-950/20 p-3 space-y-1"
                  >
                    <div className="flex items-center gap-1.5">
                      <Trophy className="h-4 w-4 text-yellow-500" />
                      <Badge variant="outline" className="text-[10px] capitalize">{item.type}</Badge>
                    </div>
                    <p className="text-sm font-medium">{item.title}</p>
                  </div>
                ))}
              </div>
            )}

            {/* Remaining items */}
            {items.length > 3 && (
              <div className="space-y-1.5">
                {items.slice(3).map((item) => (
                  <div key={item.id} className="flex items-center gap-2">
                    <span className="text-green-500">&#10003;</span>
                    <span className="text-sm flex-1 truncate">{item.title}</span>
                    <Badge variant="outline" className="text-xs capitalize">
                      {item.type}
                    </Badge>
                  </div>
                ))}
              </div>
            )}

            <div className="flex items-center gap-2 pt-2">
              <p className="text-xs text-muted-foreground">
                {items.length} item{items.length !== 1 ? 's' : ''} completed. Nice work!
              </p>
              {delta != null && (
                <Badge
                  variant={delta > 0 ? 'default' : delta < 0 ? 'secondary' : 'outline'}
                  className="text-[10px] gap-0.5"
                >
                  {delta > 0 ? <TrendingUp className="h-2.5 w-2.5" /> : delta < 0 ? <TrendingDown className="h-2.5 w-2.5" /> : <Minus className="h-2.5 w-2.5" />}
                  {delta > 0 ? '+' : ''}{delta} vs last week
                </Badge>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
