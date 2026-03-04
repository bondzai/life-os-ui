import { useMemo } from 'react'
import { CalendarDays } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { StatusBadge } from '@/core/components/status-badge'
import type { Entity } from '@/core/types'
import type { ICalEvent } from '@/lib/ical'

const typeColor: Record<string, string> = {
  task: 'bg-blue-500',
  goal: 'bg-green-500',
  event: 'bg-purple-500',
  habit: 'bg-orange-500',
  chore: 'bg-teal-500',
}

interface AgendaViewProps {
  entities: Entity[]
  icalEvents: ICalEvent[]
  feedColorMap: Record<string, string>
}

function getNext14Days(): string[] {
  const days: string[] = []
  const now = new Date()
  for (let i = 0; i < 14; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() + i)
    days.push(d.toISOString().split('T')[0])
  }
  return days
}

function formatDayHeader(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

export function AgendaView({ entities, icalEvents, feedColorMap }: AgendaViewProps) {
  const days = useMemo(() => getNext14Days(), [])
  const today = new Date().toISOString().split('T')[0]

  const entitiesByDate = useMemo(() => {
    const map: Record<string, Entity[]> = {}
    for (const entity of entities) {
      const date = entity.dueDate || (entity.metadata.date as string)
      if (date) {
        if (!map[date]) map[date] = []
        map[date].push(entity)
      }
    }
    return map
  }, [entities])

  const icalByDate = useMemo(() => {
    const map: Record<string, ICalEvent[]> = {}
    for (const ev of icalEvents) {
      const date = ev.start.toISOString().split('T')[0]
      if (!map[date]) map[date] = []
      map[date].push(ev)
    }
    return map
  }, [icalEvents])

  return (
    <div className="space-y-1">
      {days.map((day) => {
        const dayEntities = entitiesByDate[day] ?? []
        const dayIcal = icalByDate[day] ?? []
        const isToday = day === today
        const hasItems = dayEntities.length > 0 || dayIcal.length > 0

        return (
          <div key={day} className="flex gap-3">
            {/* Date column */}
            <div className={`w-28 shrink-0 pt-2 text-sm font-medium ${isToday ? 'text-primary' : 'text-muted-foreground'}`}>
              {formatDayHeader(day)}
              {isToday && <span className="ml-1 text-xs">(today)</span>}
            </div>

            {/* Items column */}
            <div className={`flex-1 border-l pl-3 py-2 ${isToday ? 'border-primary' : 'border-border'}`}>
              {!hasItems ? (
                <p className="text-xs text-muted-foreground italic">No items</p>
              ) : (
                <div className="space-y-1.5">
                  {dayEntities.map((entity) => (
                    <div key={entity.id} className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${typeColor[entity.type] ?? 'bg-gray-500'}`} />
                      <span className="text-sm truncate flex-1">{entity.title}</span>
                      <Badge variant="outline" className="text-[10px] shrink-0 capitalize">{entity.type}</Badge>
                      <StatusBadge status={entity.status} />
                    </div>
                  ))}
                  {dayIcal.map((ev) => (
                    <div key={ev.id} className="flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: feedColorMap[ev.sourceUrl] ?? '#6b7280' }}
                      />
                      <span className="text-sm italic truncate flex-1">{ev.title}</span>
                      {!ev.isAllDay && (
                        <span className="text-xs text-muted-foreground shrink-0">
                          {ev.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      )}
                      <Badge variant="secondary" className="text-[10px] shrink-0">{ev.sourceName}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )
      })}

      {days.every((d) => !(entitiesByDate[d]?.length || icalByDate[d]?.length)) && (
        <div className="text-center py-8">
          <CalendarDays className="h-8 w-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">Nothing scheduled in the next 14 days</p>
        </div>
      )}
    </div>
  )
}
