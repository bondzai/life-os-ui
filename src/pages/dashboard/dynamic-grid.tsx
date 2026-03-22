import { Pin, EyeOff } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import type { WidgetSelection } from './use-dashboard-layout'
import type { Entity, Tracker } from '@/core/types'

interface DynamicGridProps {
  widgets: WidgetSelection[]
  entities: Entity[]
  trackers: Tracker[]
  onPin: (id: string) => void
  onHide: (id: string) => void
  pinnedIds: string[]
}

export function DynamicGrid({
  widgets,
  entities,
  trackers,
  onPin,
  onHide,
  pinnedIds,
}: DynamicGridProps) {
  if (widgets.length === 0) {
    return (
      <div className="text-center py-8 text-sm text-muted-foreground">
        No widgets to display. Try adjusting your preferences.
      </div>
    )
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {widgets.map(({ widget, component: Component }) => {
        const isPinned = pinnedIds.includes(widget.id)
        return (
          <Card
            key={widget.id}
            className={`rounded-lg bg-card/50 p-0 group relative ${
              isPinned ? 'border-primary/40' : ''
            }`}
          >
            <div className="flex items-center justify-between px-3 pt-3 pb-1">
              <div className="flex items-center gap-1.5">
                {isPinned && (
                  <span className="size-1.5 rounded-full bg-primary shrink-0" />
                )}
                <span className="text-xs font-medium text-muted-foreground">
                  {widget.name}
                </span>
              </div>
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onPin(widget.id)}
                  title={isPinned ? 'Unpin widget' : 'Pin widget'}
                  className={isPinned ? 'text-primary' : ''}
                >
                  <Pin className="size-3" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => onHide(widget.id)}
                  title="Hide widget"
                >
                  <EyeOff className="size-3" />
                </Button>
              </div>
            </div>
            <div className="px-3 pb-3">
              <Component entities={entities} trackers={trackers} />
            </div>
          </Card>
        )
      })}
    </div>
  )
}
