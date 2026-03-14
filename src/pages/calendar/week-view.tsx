import { useMemo } from 'react'
import type { Entity } from '@/core/types'
import type { ICalEvent } from '@/lib/ical'

interface WeekViewProps {
  weekStart: Date
  entities: Entity[]
  icalEvents: ICalEvent[]
  feedColorMap: Record<string, string>
}

const typeStyles: Record<string, { pill: string; text: string }> = {
  task: { pill: 'bg-blue-100 dark:bg-blue-500/20', text: 'text-blue-700 dark:text-blue-300' },
  goal: { pill: 'bg-green-100 dark:bg-green-500/20', text: 'text-green-700 dark:text-green-300' },
  event: { pill: 'bg-purple-100 dark:bg-purple-500/20', text: 'text-purple-700 dark:text-purple-300' },
  habit: { pill: 'bg-orange-100 dark:bg-orange-500/20', text: 'text-orange-700 dark:text-orange-300' },
}

const DAY_NAMES = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const DAY_NAMES_SHORT = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

function formatDateKey(d: Date): string {
  return d.toISOString().split('T')[0]
}

export function WeekView({ weekStart, entities, icalEvents, feedColorMap }: WeekViewProps) {
  const today = formatDateKey(new Date())

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

  return (
    <>
      {/* Desktop: 7-column grid */}
      <div className="hidden sm:grid grid-cols-7 h-full border rounded-lg overflow-hidden">
        {days.map((day, i) => {
          const key = formatDateKey(day)
          const isToday = key === today
          const dayEntities = entitiesByDate[key] ?? []
          const dayIcal = icalByDate[key] ?? []

          return (
            <div key={key} className="border-r last:border-r-0 flex flex-col min-h-0">
              {/* Day header */}
              <div className="text-center py-2.5 border-b shrink-0">
                <div className={`text-[11px] font-medium ${isToday ? 'text-primary' : 'text-muted-foreground'}`}>
                  {DAY_NAMES[i]}
                </div>
                <div className={`text-xl font-normal mt-0.5 inline-flex items-center justify-center w-10 h-10 rounded-full ${
                  isToday ? 'bg-primary text-primary-foreground' : ''
                }`}>
                  {day.getDate()}
                </div>
              </div>
              {/* Events */}
              <div className="flex-1 p-1 space-y-px overflow-y-auto">
                {dayEntities.map((entity) => {
                  const style = typeStyles[entity.type] ?? { pill: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-700 dark:text-gray-300' }
                  return (
                    <div
                      key={entity.id}
                      className={`${style.pill} ${style.text} text-[11px] px-1.5 py-1 rounded font-medium truncate cursor-default hover:opacity-80 transition-opacity`}
                    >
                      {entity.title}
                    </div>
                  )
                })}
                {dayIcal.map((ev) => (
                  <div
                    key={ev.id}
                    className="text-[11px] px-1.5 py-1 rounded font-medium truncate cursor-default hover:opacity-80 transition-opacity"
                    style={{
                      backgroundColor: `${ev.color ?? feedColorMap[ev.sourceUrl] ?? '#6b7280'}18`,
                      color: ev.color ?? feedColorMap[ev.sourceUrl] ?? '#6b7280',
                    }}
                  >
                    {!ev.isAllDay && (
                      <span className="opacity-70">
                        {ev.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}{' '}
                      </span>
                    )}
                    {ev.title}
                  </div>
                ))}
              </div>
            </div>
          )
        })}
      </div>

      {/* Mobile: vertical stack */}
      <div className="sm:hidden space-y-1.5">
        {days.map((day, i) => {
          const key = formatDateKey(day)
          const isToday = key === today
          const dayEntities = entitiesByDate[key] ?? []
          const dayIcal = icalByDate[key] ?? []
          const isEmpty = dayEntities.length === 0 && dayIcal.length === 0

          return (
            <div key={key} className={`rounded-lg overflow-hidden ${isToday ? 'ring-1 ring-primary' : 'border'}`}>
              <div className={`flex items-center gap-2 px-3 py-2 ${isToday ? 'bg-primary text-primary-foreground' : 'bg-muted/30'}`}>
                <span className={`text-xs font-medium ${isToday ? '' : 'text-muted-foreground'}`}>{DAY_NAMES_SHORT[i]}</span>
                <span className="text-base font-medium">{day.getDate()}</span>
                {!isEmpty && (
                  <span className={`text-xs ml-auto ${isToday ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                    {dayEntities.length + dayIcal.length}
                  </span>
                )}
              </div>
              {!isEmpty && (
                <div className="px-3 py-2 space-y-1">
                  {dayEntities.map((entity) => {
                    const style = typeStyles[entity.type] ?? { pill: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-700 dark:text-gray-300' }
                    return (
                      <div key={entity.id} className={`${style.pill} ${style.text} text-sm px-2 py-1 rounded font-medium truncate`}>
                        {entity.title}
                      </div>
                    )
                  })}
                  {dayIcal.map((ev) => (
                    <div
                      key={ev.id}
                      className="text-sm px-2 py-1 rounded font-medium truncate"
                      style={{
                        backgroundColor: `${ev.color ?? feedColorMap[ev.sourceUrl] ?? '#6b7280'}18`,
                        color: ev.color ?? feedColorMap[ev.sourceUrl] ?? '#6b7280',
                      }}
                    >
                      {ev.title}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </>
  )
}
