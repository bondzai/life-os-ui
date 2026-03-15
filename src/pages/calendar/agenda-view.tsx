import { useMemo, useRef, useEffect } from 'react'
import { CalendarDays, MapPin, Clock } from 'lucide-react'
import type { Entity } from '@/core/types'
import type { ICalEvent } from '@/lib/ical'

const GCAL_COLORS: Record<string, string> = {
  task: '#039BE5',
  goal: '#33B679',
  event: '#7986CB',
  habit: '#F4511E',
  chore: '#616161',
}

interface AgendaViewProps {
  entities: Entity[]
  icalEvents: ICalEvent[]
  feedColorMap: Record<string, string>
  onEventClick?: (event: Entity | ICalEvent) => void
}

function getNext30Days(): string[] {
  const days: string[] = []
  const now = new Date()
  for (let i = 0; i < 30; i++) {
    const d = new Date(now)
    d.setDate(d.getDate() + i)
    days.push(d.toISOString().split('T')[0])
  }
  return days
}

export function AgendaView({ entities, icalEvents, feedColorMap, onEventClick }: AgendaViewProps) {
  const days = useMemo(() => getNext30Days(), [])
  const today = new Date().toISOString().split('T')[0]
  const todayRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    todayRef.current?.scrollIntoView({ block: 'start' })
  }, [])

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
      <div className="text-center py-20">
        <CalendarDays className="h-12 w-12 mx-auto text-muted-foreground/30 mb-4" />
        <p className="text-sm text-muted-foreground/60">Nothing scheduled in the next 30 days</p>
      </div>
    )
  }

  function getEventColor(ev: ICalEvent) {
    return ev.color ?? feedColorMap[ev.sourceUrl] ?? '#6b7280'
  }

  return (
    <div className="pb-20">
      {days.map((day) => {
        const dayEntities = entitiesByDate[day] ?? []
        const dayIcal = icalByDate[day] ?? []
        const isToday = day === today
        const hasItems = dayEntities.length > 0 || dayIcal.length > 0

        const d = new Date(day + 'T00:00:00')
        const weekday = d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase()
        const dayNum = d.getDate()

        return (
          <div key={day} ref={isToday ? todayRef : undefined}>
            {/* Sticky date header — Google Calendar style */}
            <div className="sticky top-0 z-10 bg-background/95 backdrop-blur-sm border-b px-4 py-2.5 flex items-center gap-3">
              <div className="flex flex-col items-center w-10">
                <span className={`text-[11px] font-medium leading-none ${isToday ? 'text-[#1a73e8]' : 'text-muted-foreground'}`}>
                  {weekday}
                </span>
                <span
                  className={`text-xl font-normal mt-0.5 w-9 h-9 flex items-center justify-center rounded-full ${
                    isToday ? 'bg-[#1a73e8] text-white' : 'text-foreground'
                  }`}
                >
                  {dayNum}
                </span>
              </div>
              {!hasItems && (
                <span className="text-sm text-muted-foreground/40 italic">No events</span>
              )}
            </div>

            {/* Event cards */}
            {hasItems && (
              <div className="px-3 py-2 space-y-1.5">
                {/* All-day iCal events first */}
                {dayIcal
                  .filter((e) => e.isAllDay)
                  .map((ev) => (
                    <button
                      key={ev.id}
                      className="w-full text-left rounded-xl overflow-hidden transition-all hover:shadow-md active:scale-[0.99]"
                      onClick={() => onEventClick?.(ev)}
                    >
                      <div className="flex items-stretch">
                        <div className="w-1 shrink-0 rounded-l-xl" style={{ backgroundColor: getEventColor(ev) }} />
                        <div
                          className="flex-1 px-4 py-3 rounded-r-xl border border-l-0"
                          style={{ backgroundColor: `${getEventColor(ev)}08` }}
                        >
                          <p className="text-sm font-medium text-foreground truncate">{ev.title}</p>
                          <p className="text-xs text-muted-foreground mt-0.5">All day</p>
                          {ev.location && (
                            <p className="text-xs text-muted-foreground/60 flex items-center gap-1 mt-1">
                              <MapPin className="w-3 h-3" />
                              <span className="truncate">{ev.location}</span>
                            </p>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}

                {/* Timed iCal events */}
                {dayIcal
                  .filter((e) => !e.isAllDay)
                  .sort((a, b) => a.start.getTime() - b.start.getTime())
                  .map((ev) => (
                    <button
                      key={ev.id}
                      className="w-full text-left rounded-xl overflow-hidden transition-all hover:shadow-md active:scale-[0.99]"
                      onClick={() => onEventClick?.(ev)}
                    >
                      <div className="flex items-stretch">
                        <div className="w-1 shrink-0 rounded-l-xl" style={{ backgroundColor: getEventColor(ev) }} />
                        <div
                          className="flex-1 px-4 py-3 rounded-r-xl border border-l-0"
                          style={{ backgroundColor: `${getEventColor(ev)}08` }}
                        >
                          <p className="text-sm font-medium text-foreground truncate">{ev.title}</p>
                          <p className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {ev.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                            {' – '}
                            {ev.end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                          </p>
                          {ev.location && (
                            <p className="text-xs text-muted-foreground/60 flex items-center gap-1 mt-1">
                              <MapPin className="w-3 h-3" />
                              <span className="truncate">{ev.location}</span>
                            </p>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}

                {/* Entity events */}
                {dayEntities.map((entity) => {
                  const color = GCAL_COLORS[entity.type] ?? '#616161'
                  return (
                    <button
                      key={entity.id}
                      className="w-full text-left rounded-xl overflow-hidden transition-all hover:shadow-md active:scale-[0.99]"
                      onClick={() => onEventClick?.(entity)}
                    >
                      <div className="flex items-stretch">
                        <div className="w-1 shrink-0 rounded-l-xl" style={{ backgroundColor: color }} />
                        <div
                          className="flex-1 px-4 py-3 rounded-r-xl border border-l-0"
                          style={{ backgroundColor: `${color}08` }}
                        >
                          <p className="text-sm font-medium text-foreground truncate">{entity.title}</p>
                          <div className="flex items-center gap-2 mt-1">
                            <span
                              className="text-[10px] font-medium px-1.5 py-0.5 rounded-full capitalize"
                              style={{ backgroundColor: `${color}20`, color }}
                            >
                              {entity.type}
                            </span>
                            <span className="text-xs text-muted-foreground capitalize">{entity.status}</span>
                          </div>
                        </div>
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
