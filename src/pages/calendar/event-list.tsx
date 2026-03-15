import type { Entity } from '@/core/types'
import type { ICalEvent } from '@/lib/ical'
import { MapPin, Clock } from 'lucide-react'

// Google Calendar color palette
const GCAL_COLORS: Record<string, string> = {
  task: '#039BE5',
  goal: '#33B679',
  event: '#7986CB',
  habit: '#F4511E',
  chore: '#616161',
}

interface EventListProps {
  date: string
  entities: Entity[]
  icalEvents: ICalEvent[]
  feedColorMap: Record<string, string>
  onEventClick?: (event: Entity | ICalEvent) => void
}

export function EventList({ date, entities, icalEvents, feedColorMap, onEventClick }: EventListProps) {
  const d = new Date(date + 'T00:00:00')
  const dateLabel = d.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  const today = new Date()
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const isToday = date === todayKey

  // Sort: all-day iCal first, then timed events by start time, then entities
  const allDayIcal = icalEvents.filter((e) => e.isAllDay)
  const timedIcal = icalEvents.filter((e) => !e.isAllDay).sort((a, b) => a.start.getTime() - b.start.getTime())

  function getEventColor(ev: ICalEvent) {
    return ev.color ?? feedColorMap[ev.sourceUrl] ?? '#6b7280'
  }

  const hasEvents = entities.length > 0 || icalEvents.length > 0

  return (
    <div className="flex flex-col h-full">
      {/* Date header */}
      <div className="px-4 pt-3 pb-2">
        <h3 className={`text-sm font-medium ${isToday ? 'text-[#1a73e8]' : 'text-muted-foreground'}`}>
          {isToday ? 'Today' : dateLabel}
          {isToday && <span className="text-muted-foreground font-normal"> — {dateLabel}</span>}
        </h3>
      </div>

      {!hasEvents ? (
        <div className="flex-1 flex items-center justify-center py-8">
          <p className="text-sm text-muted-foreground/60">No events</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-2 pb-4 space-y-1.5">
          {/* All-day events */}
          {allDayIcal.map((ev) => (
            <button
              key={ev.id}
              className="w-full text-left rounded-lg overflow-hidden transition-colors hover:bg-accent/40 active:bg-accent/60"
              onClick={() => onEventClick?.(ev)}
            >
              <div className="flex items-stretch gap-0 min-h-[56px]">
                {/* Color bar */}
                <div className="w-1 rounded-l-lg shrink-0" style={{ backgroundColor: getEventColor(ev) }} />
                <div
                  className="flex-1 px-3 py-2.5 rounded-r-lg"
                  style={{ backgroundColor: `${getEventColor(ev)}12` }}
                >
                  <p className="text-[13px] font-medium text-foreground leading-tight truncate">{ev.title}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5">All day</p>
                  {ev.location && (
                    <p className="text-[11px] text-muted-foreground/70 flex items-center gap-1 mt-0.5">
                      <MapPin className="w-3 h-3" />
                      <span className="truncate">{ev.location}</span>
                    </p>
                  )}
                </div>
              </div>
            </button>
          ))}

          {/* Timed iCal events */}
          {timedIcal.map((ev) => (
            <button
              key={ev.id}
              className="w-full text-left rounded-lg overflow-hidden transition-colors hover:bg-accent/40 active:bg-accent/60"
              onClick={() => onEventClick?.(ev)}
            >
              <div className="flex items-stretch gap-0 min-h-[56px]">
                <div className="w-1 rounded-l-lg shrink-0" style={{ backgroundColor: getEventColor(ev) }} />
                <div
                  className="flex-1 px-3 py-2.5 rounded-r-lg"
                  style={{ backgroundColor: `${getEventColor(ev)}0a` }}
                >
                  <p className="text-[13px] font-medium text-foreground leading-tight truncate">{ev.title}</p>
                  <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1">
                    <Clock className="w-3 h-3" />
                    {ev.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    {' – '}
                    {ev.end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </p>
                  {ev.location && (
                    <p className="text-[11px] text-muted-foreground/70 flex items-center gap-1 mt-0.5">
                      <MapPin className="w-3 h-3" />
                      <span className="truncate">{ev.location}</span>
                    </p>
                  )}
                </div>
              </div>
            </button>
          ))}

          {/* Entity events */}
          {entities.map((entity) => {
            const color = GCAL_COLORS[entity.type] ?? '#616161'
            return (
              <button
                key={entity.id}
                className="w-full text-left rounded-lg overflow-hidden transition-colors hover:bg-accent/40 active:bg-accent/60"
                onClick={() => onEventClick?.(entity)}
              >
                <div className="flex items-stretch gap-0 min-h-[56px]">
                  <div className="w-1 rounded-l-lg shrink-0" style={{ backgroundColor: color }} />
                  <div
                    className="flex-1 px-3 py-2.5 rounded-r-lg"
                    style={{ backgroundColor: `${color}0a` }}
                  >
                    <p className="text-[13px] font-medium text-foreground leading-tight truncate">{entity.title}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span
                        className="text-[10px] font-medium px-1.5 py-0.5 rounded-full capitalize"
                        style={{ backgroundColor: `${color}20`, color }}
                      >
                        {entity.type}
                      </span>
                      <span
                        className="text-[10px] text-muted-foreground capitalize"
                      >
                        {entity.status}
                      </span>
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
}
