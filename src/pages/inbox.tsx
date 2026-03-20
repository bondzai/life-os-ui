import { useState, useMemo, useCallback } from 'react'
import {
  Inbox,
  ArrowRight,
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
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'
import { CaptureBar } from '@/pages/today/capture-bar'
import type { Entity } from '@/core/types'
import type { LucideIcon } from 'lucide-react'

const TYPE_META: Record<string, { icon: LucideIcon; label: string; color: string }> = {
  task:  { icon: CheckSquare, label: 'Task',     color: 'text-blue-500' },
  note:  { icon: NotebookPen, label: 'Note',     color: 'text-amber-500' },
  goal:  { icon: Target,      label: 'Goal',     color: 'text-emerald-500' },
  habit: { icon: Repeat,      label: 'Habit',    color: 'text-violet-500' },
}

function getTypeInfo(entity: Entity) {
  const base = TYPE_META[entity.type] ?? { icon: NotebookPen, label: entity.type, color: 'text-muted-foreground' }
  // Detect ideas and questions by tags
  if (entity.tags?.includes('idea')) return { icon: Lightbulb, label: 'Idea', color: 'text-yellow-500' }
  if (entity.tags?.includes('question')) return { icon: HelpCircle, label: 'Question', color: 'text-cyan-500' }
  return base
}

type FilterType = 'all' | 'task' | 'note' | 'goal' | 'habit'

export function InboxPage() {
  const { items, update, create, remove } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)
  const [filter, setFilter] = useState<FilterType>('all')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editTitle, setEditTitle] = useState('')

  const inboxItems = useMemo(
    () => items.filter((e) => e.metadata.isInbox === true && e.status === 'todo'),
    [items],
  )

  const filtered = useMemo(() => {
    if (filter === 'all') return inboxItems
    return inboxItems.filter((e) => {
      if (filter === 'note') return e.type === 'note'
      return e.type === filter
    })
  }, [inboxItems, filter])

  const counts = useMemo(() => {
    const c = { all: inboxItems.length, task: 0, note: 0, goal: 0, habit: 0 }
    for (const e of inboxItems) {
      if (e.type in c) c[e.type as keyof typeof c]++
    }
    return c
  }, [inboxItems])

  const today = new Date().toISOString().split('T')[0]

  const handleConvertToTask = useCallback(
    (item: Entity) => {
      create.mutate({
        id: crypto.randomUUID(),
        type: 'task',
        title: item.title,
        description: typeof item.metadata.body === 'string' ? item.metadata.body : undefined,
        status: 'todo',
        priority: 'medium',
        tags: [],
        metadata: {},
        ownerId: currentUser?.id ?? '',
        visibility: 'private',
        dueDate: today,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      update.mutate({ id: item.id, updates: { status: 'archived', updatedAt: new Date().toISOString() } })
      notify({ title: 'Converted to task', type: 'success' })
    },
    [create, update, currentUser, today],
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
    { key: 'goal', label: 'Goals' },
    { key: 'habit', label: 'Habits' },
  ]

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Inbox className="h-5 w-5 text-primary" />
          <h1 className="text-xl font-semibold">Inbox</h1>
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
            className={`px-3 py-1.5 rounded-full text-xs font-medium transition-colors ${
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
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleStartEdit(item)} title="Edit">
                        <Pencil className="h-3 w-3" />
                      </Button>
                      {item.type !== 'task' && (
                        <Button size="sm" variant="ghost" className="h-7 px-2 text-[11px]" onClick={() => handleConvertToTask(item)} title="Convert to task">
                          <ArrowRight className="h-3 w-3 mr-1" /> Task
                        </Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleArchive(item)} title="Archive">
                        <Archive className="h-3 w-3" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive/60 hover:text-destructive" onClick={() => handleDelete(item)} title="Delete">
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
