import { useMemo } from 'react'
import { CalendarDays } from 'lucide-react'
import type { Entity } from '@/core/types'
import type { ICalEvent } from '@/lib/ical'

const typeStyles: Record<string, { hex: string }> = {
  task: { hex: '#3b82f6' },
  goal: { hex: '#22c55e' },
  event: { hex: '#a855f7' },
  habit: { hex: '#f97316' },
  chore: { hex: '#14b8a6' },
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

  const hasAny = days.some((d) => (entitiesByDate[d]?.length ?? 0) + (icalByDate[d]?.length ?? 0) > 0)

  if (!hasAny) {
    return (
      <div className="text-center py-16">
        <CalendarDays className="h-10 w-10 mx-auto text-muted-foreground/40 mb-3" />
        <p className="text-sm text-muted-foreground">Nothing scheduled in the next 14 days</p>
      </div>
    )
  }

  return (
    <div className="divide-y">
      {days.map((day) => {
        const dayEntities = entitiesByDate[day] ?? []
        const dayIcal = icalByDate[day] ?? []
        const isToday = day === today
        const hasItems = dayEntities.length > 0 || dayIcal.length > 0

        if (!hasItems) return null

        const d = new Date(day + 'T00:00:00')
        const weekday = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()
        const dayNum = d.getDate()
        const monthStr = d.toLocaleDateString('en-US', { month: 'short' })

        return (
          <div key={day} className="flex gap-4 sm:gap-6 py-3 first:pt-0">
            {/* Date column */}
            <div className="w-14 sm:w-16 shrink-0 text-center pt-1">
              <div className={`text-[11px] font-medium ${isToday ? 'text-primary' : 'text-muted-foreground'}`}>
                {weekday}
              </div>
              <div className={`text-2xl sm:text-3xl font-light inline-flex items-center justify-center w-10 h-10 sm:w-12 sm:h-12 rounded-full ${
                isToday ? 'bg-primary text-primary-foreground' : ''
              }`}>
                {dayNum}
              </div>
              {!isToday && (
                <div className="text-[10px] text-muted-foreground mt-0.5">{monthStr}</div>
              )}
            </div>

            {/* Events column */}
            <div className="flex-1 space-y-1 py-1">
              {dayEntities.map((entity) => {
                const color = typeStyles[entity.type]?.hex ?? '#6b7280'
                return (
                  <div
                    key={entity.id}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent/50 transition-colors cursor-default"
                  >
                    <div className="w-1 h-7 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{entity.title}</p>
                      <p className="text-[11px] text-muted-foreground capitalize">{entity.type}</p>
                    </div>
                  </div>
                )
              })}
              {dayIcal.map((ev) => {
                const color = ev.color ?? feedColorMap[ev.sourceUrl] ?? '#6b7280'
                return (
                  <div
                    key={ev.id}
                    className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-accent/50 transition-colors cursor-default"
                  >
                    <div className="w-1 h-7 rounded-full shrink-0" style={{ backgroundColor: color }} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{ev.title}</p>
                      <p className="text-[11px] text-muted-foreground">
                        {!ev.isAllDay ? (
                          <>
                            {ev.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            {' – '}
                            {ev.end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </>
                        ) : (
                          'All day'
                        )}
                        {' · '}{ev.sourceName}
                      </p>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )
      })}
    </div>
  )
}
