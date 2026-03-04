import { AlertTriangle, Archive, CalendarClock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { daysAgo } from './review-helpers'
import type { Entity } from '@/core/types'

interface StepStaleProps {
  items: Entity[]
  onArchive: (item: Entity) => void
}

export function StepStale({ items, onArchive }: StepStaleProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          Stale items (untouched 14+ days)
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Everything is fresh! No stale items to clean up.
          </p>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-2">
                <span className="text-sm flex-1 truncate">{item.title}</span>
                <span className="text-xs text-muted-foreground flex items-center gap-1 shrink-0">
                  <CalendarClock className="h-3 w-3" />
                  {daysAgo(item.updatedAt)}d ago
                </span>
                <Badge variant="outline" className="text-xs capitalize shrink-0">
                  {item.type}
                </Badge>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 px-2"
                  onClick={() => onArchive(item)}
                >
                  <Archive className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            <p className="text-xs text-muted-foreground pt-2">
              {items.length} stale item{items.length !== 1 ? 's' : ''}. Archive what you no longer need.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
