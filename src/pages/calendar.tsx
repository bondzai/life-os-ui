import { useState, useMemo } from 'react'
import { Plus, ChevronLeft, ChevronRight, Calendar } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { StatusBadge } from '@/core/components/status-badge'
import { PriorityBadge } from '@/core/components/priority-badge'
import { EmptyState } from '@/core/components/empty-state'
import type { Entity, EntityStatus, EntityPriority } from '@/core/types'

const DAYS_OF_WEEK = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const typeColor: Record<string, string> = {
  task: 'bg-blue-500',
  goal: 'bg-green-500',
  event: 'bg-purple-500',
  habit: 'bg-orange-500',
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

function getFirstDayOfWeek(year: number, month: number) {
  return new Date(year, month, 1).getDay()
}

function formatDateKey(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

export function CalendarPage() {
  const { items: allEntities, create } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)

  const today = new Date()
  const [viewYear, setViewYear] = useState(today.getFullYear())
  const [viewMonth, setViewMonth] = useState(today.getMonth())
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)

  const todayKey = formatDateKey(today.getFullYear(), today.getMonth(), today.getDate())

  // Group entities by dueDate
  const entitiesByDate = useMemo(() => {
    const map: Record<string, Entity[]> = {}
    for (const entity of allEntities) {
      if (entity.dueDate) {
        const key = entity.dueDate
        if (!map[key]) map[key] = []
        map[key].push(entity)
      }
    }
    return map
  }, [allEntities])

  const daysInMonth = getDaysInMonth(viewYear, viewMonth)
  const firstDay = getFirstDayOfWeek(viewYear, viewMonth)
  const monthLabel = new Date(viewYear, viewMonth).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
  })

  const goToToday = () => {
    setViewYear(today.getFullYear())
    setViewMonth(today.getMonth())
    setSelectedDate(todayKey)
  }

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11)
      setViewYear(viewYear - 1)
    } else {
      setViewMonth(viewMonth - 1)
    }
    setSelectedDate(null)
  }

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0)
      setViewYear(viewYear + 1)
    } else {
      setViewMonth(viewMonth + 1)
    }
    setSelectedDate(null)
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
  // Pad to complete the last week
  while (cells.length % 7 !== 0) cells.push(null)

  const selectedEntities = selectedDate ? (entitiesByDate[selectedDate] ?? []) : []

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={prevMonth}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <h2 className="text-lg font-semibold min-w-[180px] text-center">{monthLabel}</h2>
          <Button variant="outline" size="sm" onClick={nextMonth}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={goToToday}>
            Today
          </Button>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Event
        </Button>
      </div>

      {/* Calendar grid */}
      <div className="border rounded-lg overflow-hidden">
        {/* Day-of-week header */}
        <div className="grid grid-cols-7 border-b bg-muted/50">
          {DAYS_OF_WEEK.map((day) => (
            <div key={day} className="text-center text-xs font-medium text-muted-foreground py-2">
              {day}
            </div>
          ))}
        </div>

        {/* Date cells */}
        <div className="grid grid-cols-7">
          {cells.map((day, idx) => {
            if (day === null) {
              return <div key={`empty-${idx}`} className="min-h-[80px] border-b border-r bg-muted/20" />
            }
            const dateKey = formatDateKey(viewYear, viewMonth, day)
            const dayEntities = entitiesByDate[dateKey] ?? []
            const isToday = dateKey === todayKey
            const isSelected = dateKey === selectedDate

            return (
              <div
                key={dateKey}
                className={`min-h-[80px] border-b border-r p-1 cursor-pointer transition-colors hover:bg-accent/30 ${
                  isSelected ? 'bg-accent/50' : ''
                }`}
                onClick={() => setSelectedDate(dateKey === selectedDate ? null : dateKey)}
              >
                <div className="flex items-center justify-between">
                  <span
                    className={`text-xs font-medium inline-flex items-center justify-center w-6 h-6 rounded-full ${
                      isToday ? 'bg-primary text-primary-foreground' : ''
                    }`}
                  >
                    {day}
                  </span>
                  {dayEntities.length > 0 && (
                    <span className="text-xs text-muted-foreground">{dayEntities.length}</span>
                  )}
                </div>
                {/* Entity dots / pills */}
                <div className="mt-1 space-y-0.5">
                  {dayEntities.slice(0, 3).map((entity) => (
                    <div
                      key={entity.id}
                      className="flex items-center gap-1 truncate"
                    >
                      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${typeColor[entity.type] ?? 'bg-gray-500'}`} />
                      <span className="text-[10px] truncate">{entity.title}</span>
                    </div>
                  ))}
                  {dayEntities.length > 3 && (
                    <span className="text-[10px] text-muted-foreground">+{dayEntities.length - 3} more</span>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Selected date detail */}
      {selectedDate && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">
              {new Date(selectedDate + 'T00:00:00').toLocaleDateString('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                year: 'numeric',
              })}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {selectedEntities.length === 0 ? (
              <EmptyState
                icon={Calendar}
                title="Nothing scheduled"
                description="No items on this date."
                actionLabel="Add Event"
                onAction={() => setDialogOpen(true)}
              />
            ) : (
              <div className="space-y-2">
                {selectedEntities.map((entity) => (
                  <div key={entity.id} className="flex items-center justify-between gap-2 p-2 rounded-md border">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`w-2 h-2 rounded-full shrink-0 ${typeColor[entity.type] ?? 'bg-gray-500'}`} />
                      <span className="text-sm font-medium truncate">{entity.title}</span>
                      <Badge variant="outline" className="text-xs shrink-0">{entity.type}</Badge>
                    </div>
                    <div className="flex gap-1 shrink-0">
                      <PriorityBadge priority={entity.priority} />
                      <StatusBadge status={entity.status} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Create event dialog */}
      <EntityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entityType="event"
        title="New Event"
        defaultValues={selectedDate ? { dueDate: selectedDate } : undefined}
        onSubmit={handleCreate}
      />
    </div>
  )
}
