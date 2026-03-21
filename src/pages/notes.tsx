import { useState, useMemo } from 'react'
import { Plus, NotebookPen, Pencil, Trash2, Search, Pin } from 'lucide-react'
import { ViewToggle, getStoredView, storeView, type ViewMode } from '@/components/view-toggle'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { StatusBadge } from '@/core/components/status-badge'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import { Markdown } from '@/core/components/markdown'
import type { Entity, EntityStatus } from '@/core/types'

const moodEmoji: Record<string, string> = {
  happy: '😊',
  calm: '😌',
  neutral: '😐',
  stressed: '😰',
  sad: '😢',
}

export function NotesPage() {
  const { items: allNotes, isLoading, create, update, remove } = useEntities('note')
  const currentUser = useAuthStore((s) => s.currentUser)

  const [tab, setTab] = useState('notes')
  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'all'>('all')
  const [search, setSearch] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [isJournalCreate, setIsJournalCreate] = useState(false)
  const [editingNote, setEditingNote] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)

  const [tagFilter, setTagFilter] = useState<string>('all')
  const [viewMode, setViewMode] = useState<ViewMode>(() => getStoredView('notes'))

  const handleViewChange = (mode: ViewMode) => {
    setViewMode(mode)
    storeView('notes', mode)
  }

  // Collect all unique tags from notes
  const allTags = useMemo(() => {
    const tags = new Set<string>()
    for (const n of allNotes) {
      if (!n.metadata.isJournal) {
        for (const t of n.tags) tags.add(t)
      }
    }
    return Array.from(tags).sort()
  }, [allNotes])

  const notes = useMemo(() => {
    let filtered = allNotes.filter((n) => !n.metadata.isJournal && !n.metadata.isInbox)
    if (statusFilter !== 'all') filtered = filtered.filter((n) => n.status === statusFilter)
    if (tagFilter !== 'all') filtered = filtered.filter((n) => n.tags.includes(tagFilter))
    if (search) {
      const q = search.toLowerCase()
      filtered = filtered.filter(
        (n) =>
          n.title.toLowerCase().includes(q) ||
          (typeof n.metadata.body === 'string' && n.metadata.body.toLowerCase().includes(q)),
      )
    }
    // Pinned notes first
    filtered.sort((a, b) => {
      const pinA = a.metadata.isPinned ? 1 : 0
      const pinB = b.metadata.isPinned ? 1 : 0
      return pinB - pinA
    })
    return filtered
  }, [allNotes, statusFilter, tagFilter, search])

  const journalEntries = useMemo(() => {
    const entries = allNotes.filter((n) => n.metadata.isJournal)
    return entries.sort((a, b) => {
      const dateA = (a.metadata.date as string) || a.createdAt
      const dateB = (b.metadata.date as string) || b.createdAt
      return dateB.localeCompare(dateA)
    })
  }, [allNotes])

  const journalByDate = useMemo(() => {
    const grouped: Record<string, Entity[]> = {}
    for (const entry of journalEntries) {
      const date = (entry.metadata.date as string) || entry.createdAt.split('T')[0]
      if (!grouped[date]) grouped[date] = []
      grouped[date].push(entry)
    }
    return Object.entries(grouped).sort(([a], [b]) => b.localeCompare(a))
  }, [journalEntries])

  const today = new Date().toISOString().split('T')[0]

  const handleCreate = (values: Record<string, unknown>) => {
    const tags =
      typeof values.tags === 'string'
        ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : []
    create.mutate({
      id: crypto.randomUUID(),
      type: 'note',
      title: values.title as string,
      description: (values.description as string) || undefined,
      status: (values.status as EntityStatus) || 'todo',
      priority: (values.priority as Entity['priority']) || 'medium',
      tags,
      metadata: isJournalCreate
        ? { body: '', isJournal: true, date: today, mood: '' }
        : { body: '', isJournal: false },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: isJournalCreate ? 'Journal entry created' : 'Note created', type: 'success' })
  }

  const handleEdit = (values: Record<string, unknown>) => {
    if (!editingNote) return
    const tags =
      typeof values.tags === 'string'
        ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : []
    update.mutate({
      id: editingNote.id,
      updates: {
        title: values.title as string,
        description: (values.description as string) || undefined,
        status: values.status as EntityStatus,
        priority: values.priority as Entity['priority'],
        tags,
        updatedAt: new Date().toISOString(),
      },
    })
    setEditingNote(null)
  }

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="notes">Notes</TabsTrigger>
          <TabsTrigger value="journal">Journal</TabsTrigger>
        </TabsList>

        <TabsContent value="notes" className="space-y-4">
          {/* Header */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <Select
                value={statusFilter}
                onValueChange={(v) => setStatusFilter(v as EntityStatus | 'all')}
              >
                <SelectTrigger className="w-[140px]">
                  <SelectValue placeholder="Filter status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="todo">To Do</SelectItem>
                  <SelectItem value="done">Done</SelectItem>
                  <SelectItem value="archived">Archived</SelectItem>
                </SelectContent>
              </Select>
              {allTags.length > 0 && (
                <Select value={tagFilter} onValueChange={setTagFilter}>
                  <SelectTrigger className="w-[130px]">
                    <SelectValue placeholder="Tag" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All tags</SelectItem>
                    {allTags.map((tag) => (
                      <SelectItem key={tag} value={tag}>{tag}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Search notes..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 w-[200px]"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <ViewToggle value={viewMode} onChange={handleViewChange} />
              <Button
                size="sm"
                onClick={() => {
                  setIsJournalCreate(false)
                  setDialogOpen(true)
                }}
              >
                <Plus className="h-4 w-4 mr-1" /> New Note
              </Button>
            </div>
          </div>

          {/* Note cards */}
          {notes.length === 0 ? (
            <EmptyState
              icon={NotebookPen}
              title="No notes yet"
              description="Create your first note to start capturing ideas."
              actionLabel="New Note"
              onAction={() => {
                setIsJournalCreate(false)
                setDialogOpen(true)
              }}
            />
          ) : (
            viewMode === 'grid' ? (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {notes.map((note) => (
                  <Card key={note.id}>
                    <CardHeader className="pb-2">
                      <div className="flex items-start justify-between gap-2">
                        <CardTitle className="text-sm font-medium flex items-center gap-1">
                          {(note.metadata.isPinned as boolean) && <Pin className="h-3 w-3 text-primary shrink-0" />}
                          {note.title}
                        </CardTitle>
                        <StatusBadge status={note.status} />
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {typeof note.metadata.body === 'string' && note.metadata.body && (
                        <div className="line-clamp-3">
                          <Markdown content={note.metadata.body} className="text-xs text-muted-foreground" />
                        </div>
                      )}
                      {note.description && (
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {note.description}
                        </p>
                      )}
                      {note.tags.length > 0 && (
                        <div className="flex gap-1 flex-wrap">
                          {note.tags.map((tag) => (
                            <span key={tag} className="text-xs bg-secondary px-1.5 py-0.5 rounded">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex gap-1 pt-1">
                        <Button
                          size="sm"
                          variant="ghost"
                          className={`h-7 px-2 ${note.metadata.isPinned ? 'text-primary' : ''}`}
                          onClick={() =>
                            update.mutate({
                              id: note.id,
                              updates: {
                                metadata: { ...note.metadata, isPinned: !note.metadata.isPinned },
                                updatedAt: new Date().toISOString(),
                              },
                            })
                          }
                        >
                          <Pin className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditingNote(note)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setDeleteTarget(note)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            ) : (
              <div className="border rounded-lg divide-y">
                {notes.map((note) => (
                  <div key={note.id} className="flex items-center gap-3 px-3 py-2">
                    {(note.metadata.isPinned as boolean) && (
                      <Pin className="h-3 w-3 text-primary shrink-0" />
                    )}
                    <span className="text-sm font-medium truncate min-w-[120px] max-w-[200px]">
                      {note.title}
                    </span>
                    {note.tags.length > 0 && (
                      <div className="flex gap-1 shrink-0">
                        {note.tags.map((tag) => (
                          <span key={tag} className="text-xs bg-secondary px-1.5 py-0.5 rounded">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                    {typeof note.metadata.body === 'string' && note.metadata.body && (
                      <span className="text-xs text-muted-foreground truncate max-w-[300px]">
                        {note.metadata.body}
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-2 shrink-0">
                      <StatusBadge status={note.status} />
                      <Button
                        size="sm"
                        variant="ghost"
                        className={`h-7 px-2 ${note.metadata.isPinned ? 'text-primary' : ''}`}
                        onClick={() =>
                          update.mutate({
                            id: note.id,
                            updates: {
                              metadata: { ...note.metadata, isPinned: !note.metadata.isPinned },
                              updatedAt: new Date().toISOString(),
                            },
                          })
                        }
                      >
                        <Pin className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditingNote(note)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setDeleteTarget(note)}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )
          )}
        </TabsContent>

        <TabsContent value="journal" className="space-y-4">
          <div className="flex justify-end">
            <Button
              size="sm"
              onClick={() => {
                setIsJournalCreate(true)
                setDialogOpen(true)
              }}
            >
              <Plus className="h-4 w-4 mr-1" /> New Entry
            </Button>
          </div>

          {journalByDate.length === 0 ? (
            <EmptyState
              icon={NotebookPen}
              title="No journal entries yet"
              description="Start your daily journal to track moods and reflections."
              actionLabel="New Entry"
              onAction={() => {
                setIsJournalCreate(true)
                setDialogOpen(true)
              }}
            />
          ) : (
            <div className="space-y-6">
              {journalByDate.map(([date, entries]) => (
                <div key={date} className="space-y-2">
                  <h3 className="text-sm font-semibold text-muted-foreground">
                    {new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
                      weekday: 'long',
                      year: 'numeric',
                      month: 'long',
                      day: 'numeric',
                    })}
                  </h3>
                  {entries.map((entry) => {
                    const mood = typeof entry.metadata.mood === 'string' ? entry.metadata.mood : ''
                    return (
                      <Card key={entry.id}>
                        <CardContent className="py-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className="text-sm font-medium">{entry.title}</span>
                              {mood && (
                                <Badge variant="outline" className="text-xs">
                                  {moodEmoji[mood] || ''} {mood}
                                </Badge>
                              )}
                            </div>
                            <div className="flex gap-1">
                              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditingNote(entry)}>
                                <Pencil className="h-3.5 w-3.5" />
                              </Button>
                              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setDeleteTarget(entry)}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            </div>
                          </div>
                          {typeof entry.metadata.body === 'string' && entry.metadata.body && (
                            <p className="text-sm text-muted-foreground">{entry.metadata.body}</p>
                          )}
                          {entry.description && (
                            <p className="text-sm text-muted-foreground">{entry.description}</p>
                          )}
                        </CardContent>
                      </Card>
                    )
                  })}
                </div>
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Create dialog */}
      <EntityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entityType="note"
        title={isJournalCreate ? 'New Journal Entry' : 'New Note'}
        onSubmit={handleCreate}
      />

      {/* Edit dialog */}
      <EntityDialog
        open={!!editingNote}
        onOpenChange={(open) => !open && setEditingNote(null)}
        entityType="note"
        title="Edit Note"
        defaultValues={editingNote ?? undefined}
        onSubmit={handleEdit}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Note"
        description={`Are you sure you want to delete "${deleteTarget?.title}"?`}
        onConfirm={() => {
          if (deleteTarget) {
            remove.mutate(deleteTarget.id)
            notify({ title: 'Note deleted', type: 'success' })
            setDeleteTarget(null)
          }
        }}
      />
    </div>
  )
}
