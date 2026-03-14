import { useState, useMemo } from 'react'
import { Plus, ChevronLeft, ChevronRight, Calendar, Settings } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { StatusBadge } from '@/core/components/status-badge'
import { PriorityBadge } from '@/core/components/priority-badge'
import { useICalEvents } from '@/hooks/use-ical-events'
import { groupEventsByDate, type ICalEvent } from '@/lib/ical'
import { ICalSettingsDialog } from './calendar/ical-settings-dialog'
import { AgendaView } from './calendar/agenda-view'
import { WeekView } from './calendar/week-view'
import type { Entity, EntityStatus, EntityPriority } from '@/core/types'

const DAYS_OF_WEEK = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN']
const DAYS_OF_WEEK_SHORT = ['M', 'T', 'W', 'T', 'F', 'S', 'S']

// Google Calendar-style pill colors (bg + text)
const typeStyles: Record<string, { pill: string; text: string; hex: string }> = {
  task: { pill: 'bg-blue-100 dark:bg-blue-500/20', text: 'text-blue-700 dark:text-blue-300', hex: '#3b82f6' },
  goal: { pill: 'bg-green-100 dark:bg-green-500/20', text: 'text-green-700 dark:text-green-300', hex: '#22c55e' },
  event: { pill: 'bg-purple-100 dark:bg-purple-500/20', text: 'text-purple-700 dark:text-purple-300', hex: '#a855f7' },
  habit: { pill: 'bg-orange-100 dark:bg-orange-500/20', text: 'text-orange-700 dark:text-orange-300', hex: '#f97316' },
}

const typeDot: Record<string, string> = {
  task: 'bg-blue-500',
  goal: 'bg-green-500',
  event: 'bg-purple-500',
  habit: 'bg-orange-500',
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfWeek(year: number, month: number) {
  // Shift so Monday=0
  const day = new Date(year, month, 1).getDay()
  return day === 0 ? 6 : day - 1
}

function formatDateKey(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function CalendarPage() {
  const { items: allEntities, create } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)
  const { feeds, events: icalEvents, add, remove, toggle } = useICalEvents()

  const today = new Date()
  const [viewYear, setViewYear] = useState(today.getFullYear())
  const [viewMonth, setViewMonth] = useState(today.getMonth())
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [calendarView, setCalendarView] = useState<'month' | 'week' | 'agenda'>('month')
  const [typeFilter, setTypeFilter] = useState<string[]>(['task', 'goal', 'event', 'habit'])

  const todayKey = formatDateKey(today.getFullYear(), today.getMonth(), today.getDate())

  const entitiesByDate = useMemo(() => {
    const map: Record<string, Entity[]> = {}
    for (const entity of allEntities) {
      if (entity.dueDate && typeFilter.includes(entity.type)) {
        const key = entity.dueDate
        if (!map[key]) map[key] = []
        map[key].push(entity)
      }
    }
    return map
  }, [allEntities, typeFilter])

  const icalByDate = useMemo(() => groupEventsByDate(icalEvents), [icalEvents])

  const feedColorMap = useMemo(() => {
    const map: Record<string, string> = {}
    for (const feed of feeds) map[feed.url] = feed.color
    return map
  }, [feeds])

  const daysInMonth = getDaysInMonth(viewYear, viewMonth)
  const firstDay = getFirstDayOfWeek(viewYear, viewMonth)

  const goToToday = () => {
    setViewYear(today.getFullYear())
    setViewMonth(today.getMonth())
    setSelectedDate(todayKey)
  }

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1) }
    else setViewMonth(viewMonth - 1)
    setSelectedDate(null)
  }

  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1) }
    else setViewMonth(viewMonth + 1)
    setSelectedDate(null)
  }

  const getWeekStart = (date: Date) => {
    const d = new Date(date)
    const day = d.getDay()
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1)) // Monday start
    return d
  }

  const [weekStart, setWeekStart] = useState(() => getWeekStart(today))

  const prevWeek = () => setWeekStart((prev) => {
    const d = new Date(prev); d.setDate(d.getDate() - 7); return d
  })
  const nextWeek = () => setWeekStart((prev) => {
    const d = new Date(prev); d.setDate(d.getDate() + 7); return d
  })

  const toggleTypeFilter = (type: string) => {
    setTypeFilter((prev) =>
      prev.includes(type) ? prev.filter((t) => t !== type) : [...prev, type],
    )
  }

  const handleCreate = (values: Record<string, unknown>) => {
    const tags = typeof values.tags === 'string'
      ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : []
    create.mutate({
      id: crypto.randomUUID(),
      type: 'event',
      title: values.title as string,
      description: (values.description as string) || undefined,
      status: (values.status as EntityStatus) || 'active',
      priority: (values.priority as EntityPriority) || 'medium',
      tags,
      metadata: {},
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      dueDate: selectedDate || (values.dueDate as string) || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
  }

  // Build the grid cells
  const cells: (number | null)[] = []
  for (let i = 0; i < firstDay; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)
  while (cells.length % 7 !== 0) cells.push(null)

  const selectedEntities = selectedDate ? (entitiesByDate[selectedDate] ?? []) : []
  const selectedICalEvents = selectedDate ? (icalByDate[selectedDate] ?? []) : []

  // Previous month days for leading cells
  const prevMonthDays = getDaysInMonth(
    viewMonth === 0 ? viewYear - 1 : viewYear,
    viewMonth === 0 ? 11 : viewMonth - 1,
  )

  return (
    <div className="flex flex-col h-[calc(100vh-7rem)]">
      {/* Header — Google Calendar style */}
      <div className="flex items-center gap-2 pb-3 flex-wrap">
        {/* Left: navigation */}
        <Button
          variant="outline"
          size="sm"
          className="h-9 px-4 text-sm font-medium rounded-full"
          onClick={goToToday}
        >
          Today
        </Button>
        <div className="flex items-center">
          <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full" onClick={calendarView === 'week' ? prevWeek : prevMonth}>
            <ChevronLeft className="h-5 w-5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full" onClick={calendarView === 'week' ? nextWeek : nextMonth}>
            <ChevronRight className="h-5 w-5" />
          </Button>
        </div>
        {calendarView === 'month' && (
          <h1 className="text-lg sm:text-xl font-normal text-foreground">
            {new Date(viewYear, viewMonth).toLocaleDateString('en-US', { month: 'long' })}{' '}
            <span className="text-foreground">{viewYear}</span>
          </h1>
        )}
        {calendarView === 'week' && (
          <h1 className="text-lg sm:text-xl font-normal text-foreground">
            {weekStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
          </h1>
        )}
        {calendarView === 'agenda' && (
          <h1 className="text-lg sm:text-xl font-normal text-foreground">Upcoming</h1>
        )}

        {/* Right: view switcher + actions */}
        <div className="ml-auto flex items-center gap-2">
          {/* Type filter chips */}
          <div className="hidden md:flex gap-1">
            {Object.entries(typeStyles).map(([type, style]) => (
              <button
                key={type}
                onClick={() => toggleTypeFilter(type)}
                className={`h-7 px-2.5 rounded-full text-xs font-medium transition-all ${
                  typeFilter.includes(type)
                    ? `${style.pill} ${style.text}`
                    : 'bg-muted/50 text-muted-foreground/50 line-through'
                }`}
              >
                {type.charAt(0).toUpperCase() + type.slice(1)}
              </button>
            ))}
          </div>

          <Tabs value={calendarView} onValueChange={(v) => setCalendarView(v as 'month' | 'week' | 'agenda')}>
            <TabsList className="h-9 rounded-full">
              <TabsTrigger value="month" className="text-xs px-3 rounded-full">Month</TabsTrigger>
              <TabsTrigger value="week" className="text-xs px-3 rounded-full">Week</TabsTrigger>
              <TabsTrigger value="agenda" className="text-xs px-3 rounded-full">Schedule</TabsTrigger>
            </TabsList>
          </Tabs>

          <Button variant="ghost" size="icon" className="h-9 w-9 rounded-full" onClick={() => setSettingsOpen(true)}>
            <Settings className="h-4 w-4" />
          </Button>
          <Button size="icon" className="h-9 w-9 rounded-full" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Mobile type filters */}
      <div className="flex md:hidden gap-1 pb-2 overflow-x-auto">
        {Object.entries(typeStyles).map(([type, style]) => (
          <button
            key={type}
            onClick={() => toggleTypeFilter(type)}
            className={`h-7 px-2.5 rounded-full text-xs font-medium shrink-0 transition-all ${
              typeFilter.includes(type)
                ? `${style.pill} ${style.text}`
                : 'bg-muted/50 text-muted-foreground/50 line-through'
            }`}
          >
            {type.charAt(0).toUpperCase() + type.slice(1)}
          </button>
        ))}
      </div>

      {/* Week view */}
      {calendarView === 'week' && (
        <div className="flex-1 min-h-0">
          <WeekView
            weekStart={weekStart}
            entities={allEntities.filter((e) => typeFilter.includes(e.type))}
            icalEvents={icalEvents}
            feedColorMap={feedColorMap}
          />
        </div>
      )}

      {/* Agenda view */}
      {calendarView === 'agenda' && (
        <div className="flex-1 min-h-0 overflow-y-auto">
          <AgendaView entities={allEntities} icalEvents={icalEvents} feedColorMap={feedColorMap} />
        </div>
      )}

      {/* Month grid */}
      {calendarView === 'month' && (
        <div className="flex-1 min-h-0 flex flex-col">
          {/* Day-of-week header */}
          <div className="grid grid-cols-7">
            {DAYS_OF_WEEK.map((day, i) => (
              <div key={day} className="text-center text-[11px] font-medium text-muted-foreground py-2">
                <span className="hidden sm:inline">{day}</span>
                <span className="sm:hidden">{DAYS_OF_WEEK_SHORT[i]}</span>
              </div>
            ))}
          </div>

          {/* Date grid */}
          <div className="flex-1 grid grid-cols-7 grid-rows-[repeat(auto-fill,minmax(0,1fr))] border-t">
            {cells.map((day, idx) => {
              const isLeading = day === null && idx < firstDay
              const leadingDay = isLeading ? prevMonthDays - (firstDay - idx - 1) : null

              if (day === null) {
                return (
                  <div key={`empty-${idx}`} className="border-b border-r p-1 sm:p-1.5">
                    {leadingDay && (
                      <span className="text-[11px] sm:text-xs text-muted-foreground/40">{leadingDay}</span>
                    )}
                  </div>
                )
              }

              const dateKey = formatDateKey(viewYear, viewMonth, day)
              const dayEntities = entitiesByDate[dateKey] ?? []
              const dayICalEvents = icalByDate[dateKey] ?? []
              const totalCount = dayEntities.length + dayICalEvents.length
              const isToday = dateKey === todayKey
              const isSelected = dateKey === selectedDate

              return (
                <div
                  key={dateKey}
                  className={`border-b border-r p-0.5 sm:p-1.5 cursor-pointer transition-colors group ${
                    isSelected ? 'bg-primary/5 dark:bg-primary/10' : 'hover:bg-accent/40'
                  }`}
                  onClick={() => setSelectedDate(dateKey === selectedDate ? null : dateKey)}
                >
                  {/* Date number */}
                  <div className="flex justify-center sm:justify-start mb-0.5 sm:mb-1">
                    <span
                      className={`text-[11px] sm:text-sm inline-flex items-center justify-center w-6 h-6 sm:w-7 sm:h-7 rounded-full transition-colors ${
                        isToday
                          ? 'bg-primary text-primary-foreground font-semibold'
                          : isSelected
                            ? 'bg-primary/10 text-primary font-medium'
                            : 'text-foreground group-hover:bg-accent'
                      }`}
                    >
                      {day}
                    </span>
                  </div>

                  {/* Event pills — desktop */}
                  <div className="hidden sm:flex flex-col gap-px">
                    {dayEntities.slice(0, 3).map((entity) => {
                      const style = typeStyles[entity.type] ?? { pill: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-700 dark:text-gray-300' }
                      return (
                        <div
                          key={entity.id}
                          className={`${style.pill} ${style.text} text-[10px] leading-tight px-1.5 py-0.5 rounded truncate font-medium`}
                        >
                          {entity.title}
                        </div>
                      )
                    })}
                    {dayICalEvents.slice(0, Math.max(0, 3 - dayEntities.length)).map((ev) => (
                      <div
                        key={ev.id}
                        className="text-[10px] leading-tight px-1.5 py-0.5 rounded truncate font-medium"
                        style={{
                          backgroundColor: `${feedColorMap[ev.sourceUrl] ?? '#6b7280'}18`,
                          color: feedColorMap[ev.sourceUrl] ?? '#6b7280',
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
                    {totalCount > 3 && (
                      <button className="text-[10px] text-muted-foreground hover:text-foreground font-medium text-left px-1.5 transition-colors">
                        +{totalCount - 3} more
                      </button>
                    )}
                  </div>

                  {/* Event dots — mobile */}
                  {totalCount > 0 && (
                    <div className="flex sm:hidden justify-center gap-0.5 mt-0.5">
                      {dayEntities.slice(0, 3).map((entity) => (
                        <span key={entity.id} className={`w-[5px] h-[5px] rounded-full ${typeDot[entity.type] ?? 'bg-gray-500'}`} />
                      ))}
                      {dayICalEvents.slice(0, Math.max(0, 3 - dayEntities.length)).map((ev) => (
                        <span
                          key={ev.id}
                          className="w-[5px] h-[5px] rounded-full"
                          style={{ backgroundColor: feedColorMap[ev.sourceUrl] ?? '#6b7280' }}
                        />
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Selected date detail — slide-up panel */}
      {calendarView === 'month' && selectedDate && (
        <div className="border-t bg-background animate-in slide-in-from-bottom-2 duration-200">
          <div className="p-3 sm:p-4 max-h-[240px] overflow-y-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">
                {new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                })}
              </h3>
              <Button size="sm" variant="ghost" className="h-7 text-xs rounded-full gap-1" onClick={() => setDialogOpen(true)}>
                <Plus className="h-3.5 w-3.5" /> Add
              </Button>
            </div>
            {selectedEntities.length === 0 && selectedICalEvents.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No events</p>
            ) : (
              <div className="space-y-1.5">
                {selectedEntities.map((entity) => {
                  const style = typeStyles[entity.type] ?? { pill: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-700 dark:text-gray-300', hex: '#6b7280' }
                  return (
                    <div key={entity.id} className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-accent/50 transition-colors">
                      <div className="w-1 h-8 rounded-full shrink-0" style={{ backgroundColor: style.hex }} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">{entity.title}</p>
                        <div className="flex items-center gap-1.5 mt-0.5">
                          <Badge variant="outline" className="text-[10px] h-4 px-1 capitalize">{entity.type}</Badge>
                          <PriorityBadge priority={entity.priority} />
                          <StatusBadge status={entity.status} />
                        </div>
                      </div>
                    </div>
                  )
                })}
                {selectedICalEvents.map((ev: ICalEvent) => (
                  <div key={ev.id} className="flex items-center gap-3 px-2 py-1.5 rounded-lg hover:bg-accent/50 transition-colors">
                    <div
                      className="w-1 h-8 rounded-full shrink-0"
                      style={{ backgroundColor: feedColorMap[ev.sourceUrl] ?? '#6b7280' }}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{ev.title}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        {!ev.isAllDay && (
                          <span className="text-[11px] text-muted-foreground">
                            {ev.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            {' – '}
                            {ev.end.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        )}
                        <Badge variant="secondary" className="text-[10px] h-4 px-1">{ev.sourceName}</Badge>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <EntityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entityType="event"
        title="New Event"
        defaultValues={selectedDate ? { dueDate: selectedDate } : undefined}
        onSubmit={handleCreate}
      />
      <ICalSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        feeds={feeds}
        onAdd={add}
        onRemove={remove}
        onToggle={toggle}
      />
    </div>
  )
}
