import { useMemo } from 'react'
import type { Entity } from '@/core/types'
import type { ICalEvent } from '@/lib/ical'
import { dateKeyOf } from '@/lib/dates'

const GCAL_COLORS = {
  task: '#039BE5',
  goal: '#33B679',
  event: '#7986CB',
  habit: '#F4511E',
  chore: '#616161',
} as const

const DAYS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

function formatTime(date: Date): string {
  const h = date.getHours()
  const m = date.getMinutes()
  const suffix = h >= 12 ? 'pm' : 'am'
  const hour = h === 0 ? 12 : h > 12 ? h - 12 : h
  return m === 0 ? `${hour}${suffix}` : `${hour}:${String(m).padStart(2, '0')}${suffix}`
}

interface CalendarEvent {
  id: string
  title: string
  color: string
  time?: string
  isAllDay: boolean
  isMultiDay?: boolean
  raw: Entity | ICalEvent
}

interface MonthViewProps {
  viewYear: number
  viewMonth: number
  selectedDate: string | null
  onSelectDate: (dateKey: string) => void
  onEventClick?: (event: Entity | ICalEvent) => void
  entitiesByDate: Record<string, Entity[]>
  icalByDate: Record<string, ICalEvent[]>
  feedColorMap: Record<string, string>
}

export function MonthView({
  viewYear,
  viewMonth,
  selectedDate,
  onSelectDate,
  onEventClick,
  entitiesByDate,
  icalByDate,
  feedColorMap,
}: MonthViewProps) {
  const today = new Date()
  const todayKey = dateKeyOf(today.getFullYear(), today.getMonth(), today.getDate())
  const todayDayOfWeek = today.getDay()

  const daysInMonth = getDaysInMonth(viewYear, viewMonth)
  const firstDayOfWeek = new Date(viewYear, viewMonth, 1).getDay()

  const prevMonth = viewMonth === 0 ? 11 : viewMonth - 1
  const prevYear = viewMonth === 0 ? viewYear - 1 : viewYear
  const prevMonthDays = getDaysInMonth(prevYear, prevMonth)

  const cells = useMemo(() => {
    const result: { day: number; month: number; year: number; isCurrentMonth: boolean }[] = []
    for (let i = firstDayOfWeek - 1; i >= 0; i--) {
      result.push({ day: prevMonthDays - i, month: prevMonth, year: prevYear, isCurrentMonth: false })
    }
    for (let d = 1; d <= daysInMonth; d++) {
      result.push({ day: d, month: viewMonth, year: viewYear, isCurrentMonth: true })
    }
    const nextMo = viewMonth === 11 ? 0 : viewMonth + 1
    const nextYr = viewMonth === 11 ? viewYear + 1 : viewYear
    let trailDay = 1
    while (result.length % 7 !== 0) {
      result.push({ day: trailDay++, month: nextMo, year: nextYr, isCurrentMonth: false })
    }
    return result
  }, [viewYear, viewMonth, daysInMonth, firstDayOfWeek, prevMonth, prevYear, prevMonthDays])

  const weeks = useMemo(() => {
    const w: typeof cells[] = []
    for (let i = 0; i < cells.length; i += 7) w.push(cells.slice(i, i + 7))
    return w
  }, [cells])

  function getEventColor(ev: ICalEvent) {
    return ev.color ?? feedColorMap[ev.sourceUrl] ?? '#6b7280'
  }

  function getEventsForDate(dateKey: string): CalendarEvent[] {
    const events: CalendarEvent[] = []
    const ical = icalByDate[dateKey] ?? []
    for (const ev of ical) {
      if (ev.isAllDay) {
        events.push({
          id: ev.id, title: ev.title, color: getEventColor(ev),
          isAllDay: true, isMultiDay: ev.end.getTime() - ev.start.getTime() > 86400000, raw: ev,
        })
      }
    }
    for (const ev of ical) {
      if (!ev.isAllDay) {
        events.push({
          id: ev.id, title: ev.title, color: getEventColor(ev),
          time: formatTime(ev.start), isAllDay: false, raw: ev,
        })
      }
    }
    const entities = entitiesByDate[dateKey] ?? []
    for (const e of entities) {
      events.push({
        id: e.id, title: e.title,
        color: GCAL_COLORS[e.type as keyof typeof GCAL_COLORS] ?? '#616161',
        isAllDay: false, raw: e,
      })
    }
    return events
  }

  // Show more events on desktop
  const MAX_VISIBLE_MOBILE = 2
  const MAX_VISIBLE_DESKTOP = 3

  // Check if current view includes today (for highlighting day header)
  const isCurrentMonthView = viewYear === today.getFullYear() && viewMonth === today.getMonth()

  return (
    <div className="flex flex-col h-full select-none">
      {/* Day headers */}
      <div className="grid grid-cols-7 border-b">
        {DAYS_SHORT.map((d, i) => (
          <div
            key={i}
            className={`text-center text-[11px] md:text-xs font-medium py-1.5 md:py-2 border-r last:border-r-0
              ${isCurrentMonthView && i === todayDayOfWeek ? 'text-[#1a73e8]' : 'text-muted-foreground'}
            `}
          >
            {d}
          </div>
        ))}
      </div>

      {/* Week rows */}
      <div className="flex-1 grid" style={{ gridTemplateRows: `repeat(${weeks.length}, 1fr)` }}>
        {weeks.map((week, wi) => (
          <div key={wi} className="grid grid-cols-7 border-b last:border-b-0 min-h-0">
            {week.map((cell, di) => {
              const dateKey = dateKeyOf(cell.year, cell.month, cell.day)
              const isToday = dateKey === todayKey
              const isSelected = dateKey === selectedDate
              const events = getEventsForDate(dateKey)

              return (
                <div
                  key={di}
                  className={`border-r last:border-r-0 flex flex-col overflow-hidden cursor-pointer transition-colors
                    ${isSelected ? 'bg-accent/40' : 'hover:bg-accent/20'}
                    ${!cell.isCurrentMonth ? 'opacity-40' : ''}
                  `}
                  onClick={() => onSelectDate(dateKey)}
                >
                  {/* Date number */}
                  <div className="px-0.5 md:px-1.5 pt-0.5 md:pt-1 pb-0 md:pb-0.5 flex justify-center md:justify-end">
                    <span
                      className={`
                        text-xs md:text-sm leading-none inline-flex items-center justify-center
                        ${isToday ? 'bg-[#1a73e8] text-white rounded-full w-6 h-6 md:w-7 md:h-7 font-semibold' : ''}
                        ${!isToday && cell.isCurrentMonth ? 'text-foreground' : ''}
                        ${!cell.isCurrentMonth ? 'text-muted-foreground' : ''}
                      `}
                    >
                      {cell.day}
                    </span>
                  </div>

                  {/* Events as colored bars */}
                  <div className="flex-1 min-h-0 px-px md:px-0.5 space-y-px overflow-hidden">
                    {/* Mobile: MAX_VISIBLE_MOBILE, Desktop: MAX_VISIBLE_DESKTOP */}
                    {events.slice(0, MAX_VISIBLE_MOBILE).map((ev) => (
                      <button
                        key={ev.id}
                        className="w-full text-left rounded-[3px] md:rounded-[4px] truncate text-[9px] md:text-[11px] leading-[15px] md:leading-[18px] px-0.5 md:px-1 text-white font-medium transition-opacity hover:opacity-80 md:hidden"
                        style={{ backgroundColor: ev.color }}
                        onClick={(e) => { e.stopPropagation(); onEventClick?.(ev.raw) }}
                      >
                        {ev.time ? `${ev.title}` : ev.title}
                      </button>
                    ))}
                    {events.slice(0, MAX_VISIBLE_DESKTOP).map((ev) => (
                      <button
                        key={ev.id}
                        className="w-full text-left rounded-[4px] truncate text-[11px] leading-[18px] px-1 transition-opacity hover:opacity-80 hidden md:block"
                        style={
                          ev.isAllDay || ev.isMultiDay
                            ? { backgroundColor: ev.color, color: 'white', fontWeight: 500 }
                            : undefined
                        }
                        onClick={(e) => { e.stopPropagation(); onEventClick?.(ev.raw) }}
                      >
                        {ev.isAllDay || ev.isMultiDay ? (
                          ev.title
                        ) : (
                          <span className="flex items-center gap-1">
                            <span className="w-[6px] h-[6px] rounded-full shrink-0" style={{ backgroundColor: ev.color }} />
                            <span className="text-muted-foreground">{ev.time}</span>
                            <span className="truncate text-foreground">{ev.title}</span>
                          </span>
                        )}
                      </button>
                    ))}
                    {/* Mobile overflow */}
                    {events.length > MAX_VISIBLE_MOBILE && (
                      <div className="text-[8px] text-muted-foreground font-medium px-0.5 leading-[12px] md:hidden">
                        +{events.length - MAX_VISIBLE_MOBILE}
                      </div>
                    )}
                    {/* Desktop overflow */}
                    {events.length > MAX_VISIBLE_DESKTOP && (
                      <div className="text-[10px] text-muted-foreground font-medium px-1 leading-[16px] hidden md:block">
                        +{events.length - MAX_VISIBLE_DESKTOP} more
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
