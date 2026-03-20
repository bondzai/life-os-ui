import { useState, useMemo, useCallback } from 'react'
import {
  Inbox,
  Archive,
  Trash2,
  Pencil,
  Check,
  X,
  CheckSquare,
  NotebookPen,
  Lightbulb,
  Target,
  Repeat,
  HelpCircle,
  CalendarPlus,
  ArrowRightLeft,
  type LucideIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useEntities } from '@/core/hooks'
import { notify } from '@/lib/notify'
import { CaptureBar } from '@/pages/today/capture-bar'
import type { Entity, EntityType } from '@/core/types'

const TYPE_META: Record<string, { icon: LucideIcon; label: string; color: string }> = {
  task:  { icon: CheckSquare,  label: 'Task',  color: 'text-blue-500' },
  note:  { icon: NotebookPen,  label: 'Note',  color: 'text-amber-500' },
  goal:  { icon: Target,       label: 'Goal',  color: 'text-emerald-500' },
  habit: { icon: Repeat,       label: 'Habit', color: 'text-violet-500' },
  event: { icon: CalendarPlus, label: 'Event', color: 'text-pink-500' },
}

function getTypeInfo(entity: Entity) {
  const base = TYPE_META[entity.type] ?? { icon: NotebookPen, label: entity.type, color: 'text-muted-foreground' }
  if (entity.tags?.includes('idea')) return { icon: Lightbulb, label: 'Idea', color: 'text-yellow-500' }
  if (entity.tags?.includes('question')) return { icon: HelpCircle, label: 'Question', color: 'text-cyan-500' }
  return base
}

// Targets you can convert/promote an inbox item to
const CONVERT_TARGETS: { type: EntityType; icon: LucideIcon; label: string }[] = [
  { type: 'task',  icon: CheckSquare,  label: 'Task' },
  { type: 'note',  icon: NotebookPen,  label: 'Note' },
  { type: 'event', icon: CalendarPlus, label: 'Event' },
  { type: 'goal',  icon: Target,       label: 'Goal' },
  { type: 'habit', icon: Repeat,       label: 'Habit' },
]

type FilterType = 'all' | 'task' | 'note' | 'goal' | 'habit' | 'event'

export function InboxPage({ embedded }: { embedded?: boolean }) {
  const { items, update, remove } = useEntities()
  const [filter, setFilter] = useState<FilterType>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  const inboxItems = useMemo(
    () => items.filter((e) => e.metadata.isInbox === true && e.status === 'todo'),
    [items],
  )

  const filtered = useMemo(() => {
    if (filter === 'all') return inboxItems
    return inboxItems.filter((e) => e.type === filter)
  }, [inboxItems, filter])

  const counts = useMemo(() => {
    const c: Record<FilterType, number> = { all: inboxItems.length, task: 0, note: 0, goal: 0, habit: 0, event: 0 }
    for (const e of inboxItems) {
      if (e.type in c) c[e.type as FilterType]++
    }
    return c
  }, [inboxItems])

  // Promote: change type, strip isInbox flag, keep tags (minus 'inbox')
  const handleConvert = useCallback(
    (item: Entity, targetType: EntityType) => {
      const now = new Date().toISOString()
      const cleanTags = (item.tags ?? []).filter((t) => t !== 'inbox')
      const { isInbox: _, ...restMeta } = item.metadata as Record<string, unknown>
      update.mutate({
        id: item.id,
        updates: {
          type: targetType,
          tags: cleanTags,
          metadata: restMeta,
          updatedAt: now,
        },
      })
      const label = CONVERT_TARGETS.find((t) => t.type === targetType)?.label ?? targetType
      notify({ title: `Promoted to ${label}`, type: 'success' })
    },
    [update],
  )

  const handleArchive = useCallback(
    (item: Entity) => {
      update.mutate({ id: item.id, updates: { status: 'archived', updatedAt: new Date().toISOString() } })
      notify({ title: 'Archived', type: 'success' })
    },
    [update],
  )

  const handleDelete = useCallback(
    (item: Entity) => {
      remove.mutate(item.id)
      notify({ title: 'Deleted', type: 'success' })
    },
    [remove],
  )

  const handleStartEdit = (item: Entity) => {
    setEditingId(item.id)
    setEditTitle(item.title)
  }

  const handleSaveEdit = useCallback(
    (item: Entity) => {
      if (!editTitle.trim()) return
      update.mutate({
        id: item.id,
        updates: { title: editTitle.trim(), updatedAt: new Date().toISOString() },
      })
      setEditingId(null)
      notify({ title: 'Updated', type: 'success' })
    },
    [update, editTitle],
  )

  const handleArchiveAll = useCallback(() => {
    for (const item of filtered) {
      update.mutate({ id: item.id, updates: { status: 'archived', updatedAt: new Date().toISOString() } })
    }
    notify({ title: `Archived ${filtered.length} items`, type: 'success' })
  }, [update, filtered])

  const FILTERS: { key: FilterType; label: string }[] = [
    { key: 'all', label: 'All' },
    { key: 'task', label: 'Tasks' },
    { key: 'note', label: 'Notes' },
    { key: 'event', label: 'Events' },
    { key: 'goal', label: 'Goals' },
    { key: 'habit', label: 'Habits' },
  ]

  return (
    <div className={`${embedded ? '' : 'max-w-3xl mx-auto'} space-y-6`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {!embedded && <Inbox className="h-5 w-5 text-primary" />}
          {!embedded && <h1 className="text-xl font-semibold">Inbox</h1>}
          <span className="text-sm text-muted-foreground">
            {inboxItems.length} item{inboxItems.length !== 1 ? 's' : ''}
          </span>
        </div>
        {filtered.length > 0 && (
          <Button variant="ghost" size="sm" className="text-xs" onClick={handleArchiveAll}>
            <Archive className="h-3.5 w-3.5 mr-1" />
            Archive all
          </Button>
        )}
      </div>

      {/* Capture bar */}
      <CaptureBar />

      {/* Filters */}
      <div className="flex items-center gap-1">
        {FILTERS.map(({ key, label }) => (
          <button
            key={key}
            onClick={() => setFilter(key)}
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors cursor-pointer ${
              filter === key
                ? 'bg-primary text-primary-foreground'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            {label} {counts[key] > 0 && `(${counts[key]})`}
          </button>
        ))}
      </div>

      {/* Items */}
      {filtered.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground/50">
          <Inbox className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Inbox zero. Clean mind, clean start.</p>
        </div>
      ) : (
        <div className="space-y-1">
          {filtered.map((item) => {
            const typeInfo = getTypeInfo(item)
            const TypeIcon = typeInfo.icon
            const isEditing = editingId === item.id
            const age = Math.floor((Date.now() - new Date(item.createdAt).getTime()) / 86400000)

            return (
              <div
                key={item.id}
                className="group flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors"
              >
                {/* Type icon */}
                <TypeIcon className={`h-4 w-4 shrink-0 ${typeInfo.color}`} />

                {/* Title / edit */}
                {isEditing ? (
                  <div className="flex-1 flex items-center gap-2">
                    <Input
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSaveEdit(item)
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      className="h-7 text-sm"
                      autoFocus
                    />
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleSaveEdit(item)}>
                      <Check className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setEditingId(null)}>
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ) : (
                  <>
                    <span className="text-sm flex-1 truncate">{item.title}</span>
                    {/* Tags */}
                    {item.tags?.filter((t) => t !== 'inbox').map((tag) => (
                      <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground/60">
                        {tag}
                      </span>
                    ))}
                    {/* Age */}
                    {age > 0 && (
                      <span className={`text-[10px] ${age > 3 ? 'text-amber-500' : 'text-muted-foreground/40'}`}>
                        {age}d
                      </span>
                    )}
                    {/* Actions */}
                    <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleStartEdit(item)}>
                        <Pencil className="h-3 w-3" />
                      </Button>

                      {/* Convert/Promote dropdown */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]">
                            <ArrowRightLeft className="h-3 w-3 mr-1" /> Convert
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[140px]">
                          {CONVERT_TARGETS.filter((t) => t.type !== item.type).map((target) => {
                            const Icon = target.icon
                            return (
                              <DropdownMenuItem
                                key={target.type}
                                onClick={() => handleConvert(item, target.type)}
                                className="text-xs cursor-pointer"
                              >
                                <Icon className="h-3.5 w-3.5 mr-2" />
                                {target.label}
                              </DropdownMenuItem>
                            )
                          })}
                        </DropdownMenuContent>
                      </DropdownMenu>

                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleArchive(item)}>
                        <Archive className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive/60 hover:text-destructive" onClick={() => handleDelete(item)}>
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
