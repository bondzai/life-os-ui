import { useMemo } from 'react'
import type { Entity } from '@/core/types'
import type { ICalEvent } from '@/lib/ical'

interface WeekViewProps {
  weekStart: Date
  entities: Entity[]
  icalEvents: ICalEvent[]
  feedColorMap: Record<string, string>
}

const typeColor: Record<string, string> = {
  task: 'bg-blue-500',
  goal: 'bg-green-500',
  event: 'bg-purple-500',
  habit: 'bg-orange-500',
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

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
      <div className="hidden sm:grid grid-cols-7 border rounded-lg overflow-hidden">
        {days.map((day) => {
          const key = formatDateKey(day)
          const isToday = key === today
          const dayEntities = entitiesByDate[key] ?? []
          const dayIcal = icalByDate[key] ?? []

          return (
            <div key={key} className="border-r last:border-r-0 min-h-[200px]">
              <div className={`text-center py-2 border-b ${isToday ? 'bg-primary text-primary-foreground' : 'bg-muted/50'}`}>
                <div className="text-xs font-medium">{DAY_NAMES[day.getDay()]}</div>
                <div className="text-lg font-semibold">{day.getDate()}</div>
              </div>
              <div className="p-1 space-y-0.5">
                {dayEntities.map((entity) => (
                  <div key={entity.id} className="flex items-center gap-1 p-1 rounded hover:bg-accent/50">
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${typeColor[entity.type] ?? 'bg-gray-500'}`} />
                    <span className="text-[11px] truncate">{entity.title}</span>
                  </div>
                ))}
                {dayIcal.map((ev) => (
                  <div key={ev.id} className="flex items-center gap-1 p-1 rounded hover:bg-accent/50">
                    <span
                      className="w-1.5 h-1.5 rounded-full shrink-0"
                      style={{ backgroundColor: feedColorMap[ev.sourceUrl] ?? '#6b7280' }}
                    />
                    <span className="text-[11px] italic truncate">{ev.title}</span>
                  </div>
                ))}
                {dayEntities.length === 0 && dayIcal.length === 0 && (
                  <p className="text-[10px] text-muted-foreground text-center py-2">—</p>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {/* Mobile: vertical stack */}
      <div className="sm:hidden space-y-1">
        {days.map((day) => {
          const key = formatDateKey(day)
          const isToday = key === today
          const dayEntities = entitiesByDate[key] ?? []
          const dayIcal = icalByDate[key] ?? []
          const isEmpty = dayEntities.length === 0 && dayIcal.length === 0

          return (
            <div key={key} className={`border rounded-lg overflow-hidden ${isToday ? 'border-primary' : ''}`}>
              <div className={`flex items-center gap-2 px-3 py-1.5 ${isToday ? 'bg-primary text-primary-foreground' : 'bg-muted/50'}`}>
                <span className="text-xs font-medium">{DAY_NAMES[day.getDay()]}</span>
                <span className="text-sm font-semibold">{day.getDate()}</span>
                {!isEmpty && (
                  <span className={`text-xs ml-auto ${isToday ? 'text-primary-foreground/70' : 'text-muted-foreground'}`}>
                    {dayEntities.length + dayIcal.length} items
                  </span>
                )}
              </div>
              {!isEmpty && (
                <div className="p-2 space-y-1">
                  {dayEntities.map((entity) => (
                    <div key={entity.id} className="flex items-center gap-2">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${typeColor[entity.type] ?? 'bg-gray-500'}`} />
                      <span className="text-sm truncate">{entity.title}</span>
                    </div>
                  ))}
                  {dayIcal.map((ev) => (
                    <div key={ev.id} className="flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-full shrink-0"
                        style={{ backgroundColor: feedColorMap[ev.sourceUrl] ?? '#6b7280' }}
                      />
                      <span className="text-sm italic truncate">{ev.title}</span>
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
