import { useMemo } from 'react'
import type { Entity } from '@/core/types'
import type { ICalEvent } from '@/lib/ical'

// Google Calendar color palette
const GCAL_COLORS = {
  task: '#039BE5',     // Peacock
  goal: '#33B679',     // Sage
  event: '#7986CB',    // Lavender
  habit: '#F4511E',    // Tangerine
  chore: '#616161',    // Graphite
} as const

const DAYS_HEADER = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfWeek(year: number, month: number) {
  const day = new Date(year, month, 1).getDay()
  return day === 0 ? 6 : day - 1
}

function formatDateKey(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

interface MonthViewProps {
  viewYear: number
  viewMonth: number
  selectedDate: string | null
  onSelectDate: (dateKey: string) => void
  entitiesByDate: Record<string, Entity[]>
  icalByDate: Record<string, ICalEvent[]>
  feedColorMap: Record<string, string>
}

export function MonthView({
  viewYear,
  viewMonth,
  selectedDate,
  onSelectDate,
  entitiesByDate,
  icalByDate,
  feedColorMap,
}: MonthViewProps) {
  const today = new Date()
  const todayKey = formatDateKey(today.getFullYear(), today.getMonth(), today.getDate())

  const daysInMonth = getDaysInMonth(viewYear, viewMonth)
  const firstDay = getFirstDayOfWeek(viewYear, viewMonth)

  // Previous month trailing days
  const prevMonth = viewMonth === 0 ? 11 : viewMonth - 1
  const prevYear = viewMonth === 0 ? viewYear - 1 : viewYear
  const prevMonthDays = getDaysInMonth(prevYear, prevMonth)

  const cells = useMemo(() => {
    const result: { day: number; month: number; year: number; isCurrentMonth: boolean }[] = []

    // Leading days from previous month
    for (let i = firstDay - 1; i >= 0; i--) {
      result.push({
        day: prevMonthDays - i,
        month: prevMonth,
        year: prevYear,
        isCurrentMonth: false,
      })
    }

    // Current month days
    for (let d = 1; d <= daysInMonth; d++) {
      result.push({ day: d, month: viewMonth, year: viewYear, isCurrentMonth: true })
    }

    // Trailing days from next month
    const nextMonth = viewMonth === 11 ? 0 : viewMonth + 1
    const nextYear = viewMonth === 11 ? viewYear + 1 : viewYear
    let trailDay = 1
    while (result.length % 7 !== 0) {
      result.push({ day: trailDay++, month: nextMonth, year: nextYear, isCurrentMonth: false })
    }

    return result
  }, [viewYear, viewMonth, daysInMonth, firstDay, prevMonth, prevYear, prevMonthDays])

  function getEventColor(ev: ICalEvent) {
    return ev.color ?? feedColorMap[ev.sourceUrl] ?? '#6b7280'
  }

  return (
    <div className="select-none">
      {/* Day of week header */}
      <div className="grid grid-cols-7 mb-1">
        {DAYS_HEADER.map((d, i) => (
          <div key={i} className="text-center text-[11px] font-medium text-muted-foreground/70 py-1.5">
            {d}
          </div>
        ))}
      </div>

      {/* Date grid — compact mini-month */}
      <div className="grid grid-cols-7">
        {cells.map((cell, idx) => {
          const dateKey = formatDateKey(cell.year, cell.month, cell.day)
          const isToday = dateKey === todayKey
          const isSelected = dateKey === selectedDate
          const dayEntities = cell.isCurrentMonth ? (entitiesByDate[dateKey] ?? []) : []
          const dayIcal = cell.isCurrentMonth ? (icalByDate[dateKey] ?? []) : []

          // Collect unique dot colors (max 3)
          const dotColors: string[] = []
          for (const e of dayEntities) {
            const c = GCAL_COLORS[e.type as keyof typeof GCAL_COLORS] ?? '#616161'
            if (!dotColors.includes(c)) dotColors.push(c)
            if (dotColors.length >= 3) break
          }
          if (dotColors.length < 3) {
            for (const ev of dayIcal) {
              const c = getEventColor(ev)
              if (!dotColors.includes(c)) dotColors.push(c)
              if (dotColors.length >= 3) break
            }
          }

          return (
            <div
              key={idx}
              className="flex flex-col items-center py-1 cursor-pointer"
              onClick={() => onSelectDate(dateKey)}
            >
              {/* Date number */}
              <div
                className={`
                  w-9 h-9 sm:w-10 sm:h-10 flex items-center justify-center rounded-full text-sm transition-all duration-150
                  ${!cell.isCurrentMonth ? 'text-muted-foreground/30' : ''}
                  ${isToday && !isSelected ? 'bg-[#1a73e8] text-white font-medium' : ''}
                  ${isSelected && isToday ? 'bg-[#1a73e8] text-white font-medium ring-2 ring-[#1a73e8]/30 ring-offset-1 ring-offset-background' : ''}
                  ${isSelected && !isToday ? 'bg-[#1a73e8]/10 text-[#1a73e8] font-medium ring-1 ring-[#1a73e8]/50' : ''}
                  ${!isToday && !isSelected && cell.isCurrentMonth ? 'text-foreground hover:bg-accent/60' : ''}
                `}
              >
                {cell.day}
              </div>

              {/* Event dots */}
              <div className="flex gap-[3px] mt-0.5 h-[6px]">
                {dotColors.map((color, i) => (
                  <span
                    key={i}
                    className="w-[5px] h-[5px] rounded-full"
                    style={{ backgroundColor: color }}
                  />
                ))}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
