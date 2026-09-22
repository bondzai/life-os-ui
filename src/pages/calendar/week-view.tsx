import { useMemo, useRef, useEffect } from 'react'
import { dateKey } from '@/lib/dates'
import type { Entity } from '@/core/types'
import type { ICalEvent } from '@/lib/ical'

interface WeekViewProps {
  weekStart: Date
  entities: Entity[]
  icalEvents: ICalEvent[]
  feedColorMap: Record<string, string>
  onEventClick?: (event: Entity | ICalEvent) => void
}

const GCAL_COLORS: Record<string, string> = {
  task: '#039BE5',
  goal: '#33B679',
  event: '#7986CB',
  habit: '#F4511E',
  chore: '#616161',
}

const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const HOUR_HEIGHT = 60 // pixels per hour

function formatHour(h: number): string {
  if (h === 0) return '12 AM'
  if (h < 12) return `${h} AM`
  if (h === 12) return '12 PM'
  return `${h - 12} PM`
}

export function WeekView({ weekStart, entities, icalEvents, feedColorMap, onEventClick }: WeekViewProps) {
  const today = dateKey(new Date())
  const scrollRef = useRef<HTMLDivElement>(null)

  // Scroll to 8 AM on mount
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = 8 * HOUR_HEIGHT
    }
  }, [weekStart])

  const days = useMemo(() => {
    const result: Date[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStart)
      d.setDate(d.getDate() + i)
      result.push(d)
    }
    return result
  }, [weekStart])

  const entitiesByDate = useMemo(() => {
    const map: Record<string, Entity[]> = {}
    for (const e of entities) {
      if (e.dueDate) {
        if (!map[e.dueDate]) map[e.dueDate] = []
        map[e.dueDate].push(e)
      }
    }
    return map
  }, [entities])

  const icalByDate = useMemo(() => {
    const map: Record<string, ICalEvent[]> = {}
    for (const ev of icalEvents) {
      const key = ev.start.toISOString().split('T')[0]
      if (!map[key]) map[key] = []
      map[key].push(ev)
    }
    return map
  }, [icalEvents])

  function getEventColor(ev: ICalEvent) {
    return ev.color ?? feedColorMap[ev.sourceUrl] ?? '#6b7280'
  }

  // Current time indicator position
  const now = new Date()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const currentTimeTop = (currentMinutes / 60) * HOUR_HEIGHT


  return (
    <div className="flex flex-col h-full border rounded-xl overflow-hidden bg-background">
      {/* Day headers — fixed */}
      <div className="flex border-b shrink-0 bg-background z-10">
        {/* Time gutter spacer */}
        <div className="w-12 sm:w-14 shrink-0 border-r" />
        {/* Day columns */}
        {days.map((day, i) => {
          const key = dateKey(day)
          const isToday = key === today
          return (
            <div
              key={key}
              className={`flex-1 text-center py-2 border-r last:border-r-0 ${isToday ? 'bg-[#1a73e8]/5' : ''}`}
            >
              <div className={`text-[11px] font-medium ${isToday ? 'text-[#1a73e8]' : 'text-muted-foreground'}`}>
                {DAY_NAMES[i]}
              </div>
              <div
                className={`text-lg font-normal mt-0.5 mx-auto w-8 h-8 flex items-center justify-center rounded-full ${
                  isToday ? 'bg-[#1a73e8] text-white' : 'text-foreground'
                }`}
              >
                {day.getDate()}
              </div>
            </div>
          )
        })}
      </div>

      {/* All-day events row */}
      {(() => {
        const hasAllDay = days.some((d) => {
          const key = dateKey(d)
          return (icalByDate[key] ?? []).some((e) => e.isAllDay)
        })
        if (!hasAllDay) return null
        return (
          <div className="flex border-b shrink-0">
            <div className="w-12 sm:w-14 shrink-0 border-r flex items-center justify-center">
              <span className="text-[10px] text-muted-foreground">ALL</span>
            </div>
            {days.map((day) => {
              const key = dateKey(day)
              const allDay = (icalByDate[key] ?? []).filter((e) => e.isAllDay)
              const isToday = key === today
              return (
                <div
                  key={key}
                  className={`flex-1 border-r last:border-r-0 px-0.5 py-1 space-y-0.5 ${isToday ? 'bg-[#1a73e8]/5' : ''}`}
                >
                  {allDay.map((ev) => (
                    <button
                      key={ev.id}
                      className="w-full text-left rounded px-1 py-0.5 text-[10px] font-medium truncate transition-opacity hover:opacity-80"
                      style={{
                        backgroundColor: getEventColor(ev),
                        color: '#fff',
                      }}
                      onClick={() => onEventClick?.(ev)}
                    >
                      {ev.title}
                    </button>
                  ))}
                </div>
              )
            })}
          </div>
        )
      })()}

      {/* Scrollable time grid */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto overflow-x-hidden relative">
        <div className="flex" style={{ height: 24 * HOUR_HEIGHT }}>
          {/* Time gutter */}
          <div className="w-12 sm:w-14 shrink-0 border-r relative">
            {HOURS.map((h) => (
              <div
                key={h}
                className="absolute left-0 right-0 text-right pr-2 -translate-y-1/2 text-[10px] text-muted-foreground"
                style={{ top: h * HOUR_HEIGHT }}
              >
                {h > 0 ? formatHour(h) : ''}
              </div>
            ))}
          </div>

          {/* Day columns with hour grid */}
          {days.map((day) => {
            const key = dateKey(day)
            const isToday = key === today
            const dayEntities = entitiesByDate[key] ?? []
            const dayIcal = (icalByDate[key] ?? []).filter((e) => !e.isAllDay)

            return (
              <div
                key={key}
                className={`flex-1 border-r last:border-r-0 relative ${isToday ? 'bg-[#1a73e8]/[0.03]' : ''}`}
              >
                {/* Hour grid lines */}
                {HOURS.map((h) => (
                  <div
                    key={h}
                    className="absolute left-0 right-0 border-t border-border/50"
                    style={{ top: h * HOUR_HEIGHT }}
                  />
                ))}

                {/* Current time indicator */}
                {isToday && (
                  <div
                    className="absolute left-0 right-0 z-20 pointer-events-none"
                    style={{ top: currentTimeTop }}
                  >
                    <div className="relative">
                      <div className="absolute -left-[5px] -top-[5px] w-[10px] h-[10px] rounded-full bg-[#ea4335]" />
                      <div className="h-[2px] bg-[#ea4335] w-full" />
                    </div>
                  </div>
                )}

                {/* Timed iCal events */}
                {dayIcal.map((ev) => {
                  const startMinutes = ev.start.getHours() * 60 + ev.start.getMinutes()
                  const endMinutes = ev.end.getHours() * 60 + ev.end.getMinutes()
                  const duration = Math.max(endMinutes - startMinutes, 30) // min 30 min height
                  const top = (startMinutes / 60) * HOUR_HEIGHT
                  const height = (duration / 60) * HOUR_HEIGHT
                  const color = getEventColor(ev)

                  return (
                    <button
                      key={ev.id}
                      className="absolute left-0.5 right-0.5 rounded-md overflow-hidden text-left transition-opacity hover:opacity-90 z-10"
                      style={{
                        top,
                        height: Math.max(height, 20),
                        backgroundColor: color,
                      }}
                      onClick={() => onEventClick?.(ev)}
                    >
                      <div className="px-1.5 py-0.5">
                        <p className="text-[10px] font-medium text-white truncate leading-tight">
                          {ev.title}
                        </p>
                        {height > 35 && (
                          <p className="text-[9px] text-white/80 truncate">
                            {ev.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                          </p>
                        )}
                      </div>
                    </button>
                  )
                })}

                {/* Entity events — placed at 9 AM by default (they don't have times) */}
                {dayEntities.map((entity, eIdx) => {
                  const color = GCAL_COLORS[entity.type] ?? '#616161'
                  const top = 9 * HOUR_HEIGHT + eIdx * 28

                  return (
                    <button
                      key={entity.id}
                      className="absolute left-0.5 right-0.5 rounded-md overflow-hidden text-left transition-opacity hover:opacity-90 z-10"
                      style={{
                        top,
                        height: 24,
                        backgroundColor: `${color}cc`,
                      }}
                      onClick={() => onEventClick?.(entity)}
                    >
                      <div className="px-1.5 py-0.5">
                        <p className="text-[10px] font-medium text-white truncate leading-tight">
                          {entity.title}
                        </p>
                      </div>
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
