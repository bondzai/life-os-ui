import { useState, useMemo, useCallback } from 'react'
import { Plus, ChevronLeft, ChevronRight, Settings } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { useICalEvents } from '@/hooks/use-ical-events'
import { useGCalAuth } from '@/hooks/use-gcal-auth'
import { groupEventsByDate, type ICalEvent } from '@/lib/ical'
import { notify } from '@/lib/notify'
import { ICalSettingsDialog } from './calendar/ical-settings-dialog'
import { MonthView } from './calendar/month-view'
import { AgendaView } from './calendar/agenda-view'
import { WeekView } from './calendar/week-view'
import { EventDetailSheet } from './calendar/event-detail-sheet'
import { GCalEventDialog } from './calendar/gcal-event-dialog'
import type { Entity, EntityStatus, EntityPriority } from '@/core/types'

// Google Calendar color palette for entity types
const GCAL_TYPE_COLORS: Record<string, string> = {
  task: '#039BE5',
  goal: '#33B679',
  event: '#7986CB',
  habit: '#F4511E',
  chore: '#616161',
}

type CalendarViewMode = 'month' | 'week' | 'schedule'

function formatDateKey(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function CalendarPage() {
  const queryClient = useQueryClient()
  const { items: allEntities, create, remove: removeEntity } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)
  const { feeds, events: icalEvents, add, remove, toggle } = useICalEvents()
  const gcal = useGCalAuth()

  const refreshCalendar = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['ical-events'] })
  }, [queryClient])

  const today = new Date()
  const [viewYear, setViewYear] = useState(today.getFullYear())
  const [viewMonth, setViewMonth] = useState(today.getMonth())
  const [selectedDate, setSelectedDate] = useState<string | null>(
    formatDateKey(today.getFullYear(), today.getMonth(), today.getDate())
  )
  const [dialogOpen, setDialogOpen] = useState(false)
  const [gcalDialogOpen, setGcalDialogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [calendarView, setCalendarView] = useState<CalendarViewMode>('month')
  const [typeFilter, setTypeFilter] = useState<string[]>(['event'])
  const [detailEvent, setDetailEvent] = useState<Entity | ICalEvent | null>(null)
  const [detailOpen, setDetailOpen] = useState(false)

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

  // Month navigation
  const goToToday = () => {
    setViewYear(today.getFullYear())
    setViewMonth(today.getMonth())
    setSelectedDate(todayKey)
    if (calendarView === 'week') {
      setWeekStart(getWeekStart(today))
    }
  }

  const prevMonth = () => {
    if (viewMonth === 0) { setViewMonth(11); setViewYear(viewYear - 1) }
    else setViewMonth(viewMonth - 1)
  }

  const nextMonth = () => {
    if (viewMonth === 11) { setViewMonth(0); setViewYear(viewYear + 1) }
    else setViewMonth(viewMonth + 1)
  }

  // Week navigation
  const getWeekStart = (date: Date) => {
    const d = new Date(date)
    const day = d.getDay()
    d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
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
      status: (values.status as EntityStatus) || 'todo',
      priority: (values.priority as EntityPriority) || 'medium',
      tags,
      metadata: {},
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      dueDate: selectedDate || (values.dueDate as string) || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Event created', type: 'success' })
  }

  const handleEventClick = useCallback((event: Entity | ICalEvent) => {
    setDetailEvent(event)
    setDetailOpen(true)
  }, [])

  const handleDateSelect = (dateKey: string) => {
    setSelectedDate(dateKey)
    const [y, m] = dateKey.split('-').map(Number)
    if (y !== viewYear || m - 1 !== viewMonth) {
      setViewYear(y)
      setViewMonth(m - 1)
    }
  }

  const handleEditEvent = useCallback(async (eventId: string, data: {
    summary?: string
    description?: string
    location?: string
    start?: { dateTime: string; timeZone: string }
    end?: { dateTime: string; timeZone: string }
  }) => {
    await gcal.updateEvent(eventId, data)
    notify({ title: 'Event updated', type: 'success' })
    refreshCalendar()
  }, [gcal, refreshCalendar])

  const handleDeleteEvent = useCallback(async (eventId: string) => {
    await gcal.deleteEvent(eventId)
    notify({ title: 'Event deleted', type: 'success' })
    refreshCalendar()
  }, [gcal, refreshCalendar])

  const handleDeleteEntity = useCallback((id: string) => {
    removeEntity.mutate(id)
    notify({ title: 'Event deleted', type: 'success' })
  }, [removeEntity])


  const headerTitle = calendarView === 'month'
    ? new Date(viewYear, viewMonth).toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
    : calendarView === 'week'
      ? weekStart.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
      : 'Schedule'

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)]">
      {/* Toolbar row — nav + title + actions */}
      <div className="flex items-center gap-1 pb-2 shrink-0 flex-wrap">
        {/* Left group: nav + title */}
        <div className="flex items-center gap-1 mr-auto">
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full"
            onClick={calendarView === 'week' ? prevWeek : prevMonth}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full"
            onClick={calendarView === 'week' ? nextWeek : nextMonth}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <h1 className="text-base font-medium ml-1">{headerTitle}</h1>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 px-2 text-xs rounded-full text-[#1a73e8] hover:bg-[#1a73e8]/10 ml-1"
            onClick={goToToday}
          >
            Today
          </Button>
        </div>

        {/* Right group: view switcher + add + settings */}
        <div className="flex items-center gap-1.5">
          {/* View switcher */}
          <div className="flex bg-muted rounded-full p-0.5 gap-0.5">
            {(['month', 'week', 'schedule'] as const).map((view) => (
              <button
                key={view}
                className={`px-2.5 py-1 text-xs font-medium rounded-full transition-colors ${
                  calendarView === view
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => setCalendarView(view)}
              >
                {view === 'schedule' ? 'Schedule' : view.charAt(0).toUpperCase() + view.slice(1)}
              </button>
            ))}
          </div>

          {/* Add button */}
          {gcal.isConnected ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" className="h-8 gap-1.5 rounded-full bg-[#1a73e8] hover:bg-[#1557b0] text-white">
                  <Plus className="h-4 w-4" />
                  <span className="text-xs hidden sm:inline">New</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuItem onClick={() => setGcalDialogOpen(true)}>
                  <svg className="w-4 h-4 mr-2 shrink-0" viewBox="0 0 24 24">
                    <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                    <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                    <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                    <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                  </svg>
                  Google Calendar event
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDialogOpen(true)}>
                  <Plus className="w-4 h-4 mr-2" />
                  Local event
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button size="sm" className="h-8 gap-1.5 rounded-full" onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4" />
              <span className="text-xs hidden sm:inline">New</span>
            </Button>
          )}

          {/* Settings */}
          <Button variant="ghost" size="icon" className="h-8 w-8 rounded-full" onClick={() => setSettingsOpen(true)}>
            <Settings className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Calendar filter chips — entity types + iCal feeds */}
      <div className="flex gap-1.5 pb-2 overflow-x-auto shrink-0 scrollbar-none">
        {Object.entries(GCAL_TYPE_COLORS).map(([type, color]) => (
          <button
            key={type}
            onClick={() => toggleTypeFilter(type)}
            className={`h-6 px-2.5 rounded-full text-xs font-medium shrink-0 transition-colors border ${
              typeFilter.includes(type)
                ? 'border-transparent'
                : 'border-border bg-transparent text-muted-foreground/50 line-through'
            }`}
            style={typeFilter.includes(type) ? {
              backgroundColor: `${color}18`,
              color,
            } : undefined}
          >
            {type.charAt(0).toUpperCase() + type.slice(1)}
          </button>
        ))}
        {feeds.map((feed) => (
          <button
            key={feed.id}
            onClick={() => toggle(feed.id)}
            className={`h-6 px-2.5 rounded-full text-xs font-medium shrink-0 transition-colors border flex items-center gap-1.5 ${
              feed.enabled
                ? 'border-transparent'
                : 'border-border bg-transparent text-muted-foreground/50 line-through'
            }`}
            style={feed.enabled ? {
              backgroundColor: `${feed.color}18`,
              color: feed.color,
            } : undefined}
          >
            <span
              className="w-2 h-2 rounded-full shrink-0"
              style={{ backgroundColor: feed.enabled ? feed.color : 'currentColor', opacity: feed.enabled ? 1 : 0.3 }}
            />
            {feed.name}
          </button>
        ))}
      </div>

      {/* Main content */}
      <div className="flex-1 min-h-0 flex flex-col">
        {/* Month view — full Google Calendar grid */}
        {calendarView === 'month' && (
          <div className="flex-1 min-h-0">
            <MonthView
              viewYear={viewYear}
              viewMonth={viewMonth}
              selectedDate={selectedDate}
              onSelectDate={handleDateSelect}
              onEventClick={handleEventClick}
              entitiesByDate={entitiesByDate}
              icalByDate={icalByDate}
              feedColorMap={feedColorMap}
            />
          </div>
        )}

        {/* Week view */}
        {calendarView === 'week' && (
          <div className="flex-1 min-h-0">
            <WeekView
              weekStart={weekStart}
              entities={allEntities.filter((e) => typeFilter.includes(e.type))}
              icalEvents={icalEvents}
              feedColorMap={feedColorMap}
              onEventClick={handleEventClick}
            />
          </div>
        )}

        {/* Schedule / Agenda view */}
        {calendarView === 'schedule' && (
          <div className="flex-1 min-h-0 overflow-y-auto">
            <AgendaView
              entities={allEntities.filter((e) => typeFilter.includes(e.type))}
              icalEvents={icalEvents}
              feedColorMap={feedColorMap}
              onEventClick={handleEventClick}
            />
          </div>
        )}
      </div>

      {/* Event detail bottom sheet */}
      <EventDetailSheet
        event={detailEvent}
        open={detailOpen}
        onOpenChange={setDetailOpen}
        feedColorMap={feedColorMap}
        googleConnected={gcal.isConnected}
        onEditEvent={handleEditEvent}
        onDeleteEvent={handleDeleteEvent}
        onDeleteEntity={handleDeleteEntity}
      />

      {/* Entity creation dialog */}
      <EntityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entityType="event"
        title="New Event"
        defaultValues={selectedDate ? { dueDate: selectedDate } : undefined}
        onSubmit={handleCreate}
      />

      {/* Google Calendar event creation sheet */}
      <GCalEventDialog
        open={gcalDialogOpen}
        onOpenChange={setGcalDialogOpen}
        defaultDate={selectedDate || undefined}
        onSubmit={async (eventData) => {
          await gcal.createEvent(eventData)
          setGcalDialogOpen(false)
          notify({ title: 'Event created', type: 'success' })
          refreshCalendar()
        }}
      />

      {/* iCal settings dialog */}
      <ICalSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        feeds={feeds}
        onAdd={add}
        onRemove={remove}
        onToggle={toggle}
        googleConnected={gcal.isConnected}
        onGoogleConnect={gcal.connect}
        onGoogleDisconnect={gcal.disconnect}
      />
    </div>
  )
}
