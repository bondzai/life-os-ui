import { useState, useMemo } from 'react'
import { CalendarPlus, Pencil, Trash2, MapPin, Clock, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import type { Entity, EntityStatus } from '@/core/types'

type TimeFilter = 'upcoming' | 'today' | 'past' | 'all'

function dayStart(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x }

function relativeDate(dateStr: string): string {
  const d = dayStart(new Date(dateStr))
  const t = dayStart(new Date())
  const diff = Math.round((d.getTime() - t.getTime()) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff === -1) return 'Yesterday'
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function dateGroup(dateStr: string): string {
  const d = dayStart(new Date(dateStr))
  const t = dayStart(new Date())
  const diff = Math.round((d.getTime() - t.getTime()) / 86400000)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Tomorrow'
  if (diff < 0) return 'Past'
  if (diff <= 7) return 'This Week'
  return 'Later'
}

const GROUP_ORDER = ['Today', 'Tomorrow', 'This Week', 'Later', 'Past', 'No Date']

export function EventsPage() {
  const { items: allEvents, isLoading, create, update, remove } = useEntities('event')
  const currentUser = useAuthStore((s) => s.currentUser)

  const [filter, setFilter] = useState<TimeFilter>('upcoming')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingEvent, setEditingEvent] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)

  const today = dayStart(new Date())

  const filtered = useMemo(() => {
    let list: Entity[]
    switch (filter) {
      case 'upcoming':
        list = allEvents.filter((e) => e.dueDate && dayStart(new Date(e.dueDate)) >= today)
          .sort((a, b) => new Date(a.dueDate!).getTime() - new Date(b.dueDate!).getTime())
        break
      case 'today':
        list = allEvents.filter((e) => e.dueDate && dayStart(new Date(e.dueDate)).getTime() === today.getTime())
        break
      case 'past':
        list = allEvents.filter((e) => e.dueDate && dayStart(new Date(e.dueDate)) < today)
          .sort((a, b) => new Date(b.dueDate!).getTime() - new Date(a.dueDate!).getTime())
        break
      default:
        list = [...allEvents].sort((a, b) => {
          if (!a.dueDate) return 1
          if (!b.dueDate) return -1
          return new Date(a.dueDate).getTime() - new Date(b.dueDate).getTime()
        })
    }
    return list
  }, [allEvents, filter, today])

  const groups = useMemo(() => {
    const map = new Map<string, Entity[]>()
    for (const e of filtered) {
      const g = e.dueDate ? dateGroup(e.dueDate) : 'No Date'
      const list = map.get(g) ?? []
      list.push(e)
      map.set(g, list)
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ label: g, events: map.get(g)! }))
  }, [filtered])

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
      priority: (values.priority as Entity['priority']) || 'medium',
      tags,
      metadata: { time: (values.time as string) || undefined, location: (values.location as string) || undefined },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      dueDate: (values.dueDate as string) || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Event created', type: 'success' })
  }

  const handleEdit = (values: Record<string, unknown>) => {
    if (!editingEvent) return
    const tags = typeof values.tags === 'string'
      ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : []
    update.mutate({
      id: editingEvent.id,
      updates: {
        title: values.title as string,
        description: (values.description as string) || undefined,
        status: values.status as EntityStatus,
        priority: values.priority as Entity['priority'],
        tags,
        metadata: { ...editingEvent.metadata, time: (values.time as string) || undefined, location: (values.location as string) || undefined },
        dueDate: (values.dueDate as string) || undefined,
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Event updated', type: 'success' })
    setEditingEvent(null)
  }

  const handleDone = (event: Entity) => {
    update.mutate({ id: event.id, updates: { status: 'done', updatedAt: new Date().toISOString() } })
  }

  const FILTERS: { key: TimeFilter; label: string; count: number }[] = [
    { key: 'upcoming', label: 'Upcoming', count: allEvents.filter((e) => e.dueDate && dayStart(new Date(e.dueDate)) >= today).length },
    { key: 'today', label: 'Today', count: allEvents.filter((e) => e.dueDate && dayStart(new Date(e.dueDate)).getTime() === today.getTime()).length },
    { key: 'past', label: 'Past', count: allEvents.filter((e) => e.dueDate && dayStart(new Date(e.dueDate)) < today).length },
    { key: 'all', label: 'All', count: allEvents.length },
  ]

  if (isLoading) return <div className="p-8 text-center text-muted-foreground/50 text-sm">Loading...</div>

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <CalendarPlus className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Events</h1>
          <span className="text-sm text-muted-foreground">{allEvents.length}</span>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Event
        </Button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-1">
        {FILTERS.map(({ key, label, count }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
              filter === key
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {label} {count > 0 && `(${count})`}
          </button>
        ))}
      </div>

      {/* Events */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground/50">
          <CalendarPlus className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No events. Create one to get started.</p>
        </div>
      ) : (
        <div className="space-y-5">
          {groups.map(({ label, events }) => (
            <div key={label}>
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-2">{label}</h3>
              <div className="space-y-0.5">
                {events.map((event) => {
                  const isDone = event.status === 'done'
                  return (
                    <div
                      key={event.id}
                      className="group flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors"
                    >
                      {/* Done toggle */}
                      <button
                        onClick={() => isDone
                          ? update.mutate({ id: event.id, updates: { status: 'todo', updatedAt: new Date().toISOString() } })
                          : handleDone(event)
                        }
                        className={`h-4 w-4 rounded-full border-2 shrink-0 transition-colors cursor-pointer ${
                          isDone ? 'bg-green-500 border-green-500' : 'border-border hover:border-primary'
                        }`}
                      />

                      {/* Time */}
                      {!!event.metadata.time && (
                        <span className="flex items-center gap-1 text-[11px] font-mono text-muted-foreground shrink-0">
                          <Clock className="h-3 w-3" />
                          {event.metadata.time as string}
                        </span>
                      )}

                      {/* Title */}
                      <span className={`text-sm flex-1 truncate ${isDone ? 'line-through text-muted-foreground/50' : ''}`}>
                        {event.title}
                      </span>

                      {/* Location */}
                      {!!event.metadata.location && (
                        <span className="hidden sm:flex items-center gap-1 text-[10px] text-muted-foreground/50 shrink-0">
                          <MapPin className="h-3 w-3" />
                          {event.metadata.location as string}
                        </span>
                      )}

                      {/* Date */}
                      {event.dueDate && (
                        <span className="text-[10px] text-muted-foreground/40 shrink-0">
                          {relativeDate(event.dueDate)}
                        </span>
                      )}

                      {/* Actions */}
                      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setEditingEvent(event)}>
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive/60 hover:text-destructive" onClick={() => setDeleteTarget(event)}>
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Dialogs */}
      <EntityDialog open={dialogOpen} onOpenChange={setDialogOpen} entityType="event" title="New Event" onSubmit={handleCreate} />
      <EntityDialog open={!!editingEvent} onOpenChange={(open) => !open && setEditingEvent(null)} entityType="event" title="Edit Event" defaultValues={editingEvent ?? undefined} onSubmit={handleEdit} />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Event"
        description={`Delete "${deleteTarget?.title}"?`}
        onConfirm={() => {
          if (deleteTarget) {
            remove.mutate(deleteTarget.id)
            notify({ title: 'Deleted', type: 'success' })
            setDeleteTarget(null)
          }
        }}
      />
    </div>
  )
}
