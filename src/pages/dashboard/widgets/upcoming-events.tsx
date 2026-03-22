import { CalendarDays } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { registerWidget, type WidgetProps } from './registry'

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr)
  d.setDate(d.getDate() + days)
  return d.toISOString().split('T')[0]
}

function UpcomingEvents({ entities }: WidgetProps) {
  const today = new Date().toISOString().split('T')[0]
  const tomorrow = addDays(today, 1)

  const events = entities
    .filter(
      (e) =>
        e.type === 'event' &&
        e.dueDate &&
        (e.dueDate === today || e.dueDate === tomorrow) &&
        e.status !== 'archived',
    )
    .sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))

  if (events.length === 0)
    return <p className="text-xs text-muted-foreground">No upcoming events</p>

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <CalendarDays className="size-3" />
        <span>{events.length} upcoming</span>
      </div>
      {events.slice(0, 5).map((e) => (
        <div key={e.id} className="flex items-center justify-between gap-2">
          <span className="text-sm truncate">{e.title}</span>
          <Badge
            variant={e.dueDate === today ? 'default' : 'secondary'}
            className="text-xs shrink-0"
          >
            {e.dueDate === today ? 'Today' : 'Tomorrow'}
          </Badge>
        </div>
      ))}
    </div>
  )
}

registerWidget(
  {
    id: 'upcoming-events',
    name: 'Upcoming Events',
    relevance: ({ entities, today }) => {
      const tomorrow = addDays(today, 1)
      const events = entities.filter(
        (e) =>
          e.type === 'event' &&
          e.dueDate &&
          (e.dueDate === today || e.dueDate === tomorrow) &&
          e.status !== 'archived',
      )
      if (events.length === 0) return null
      return events.some((e) => e.dueDate === today) ? 2 : 1
    },
  },
  UpcomingEvents,
)
