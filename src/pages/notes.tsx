import { useState, useMemo } from 'react'
import { Plus, NotebookPen, Pencil, Trash2, Search, Pin, Scale, X, CheckCircle2, XCircle } from 'lucide-react'
import { ViewToggle, getStoredView, storeView, type ViewMode } from '@/components/view-toggle'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
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

type RevisitStatus = 'pending' | 'validated' | 'reversed'
type DecisionFilter = 'all' | 'pending' | 'validated' | 'reversed'

interface DecisionFormState {
  title: string
  body: string
  reasoning: string
  alternatives: string[]
  linkedProjectId: string
  linkedGoalId: string
  revisitOption: '30' | '90' | 'custom' | 'never'
  revisitDate: string
  decisionDate: string
}

function emptyDecisionForm(): DecisionFormState {
  return {
    title: '',
    body: '',
    reasoning: '',
    alternatives: [],
    linkedProjectId: '',
    linkedGoalId: '',
    revisitOption: '30',
    revisitDate: '',
    decisionDate: new Date().toISOString().split('T')[0],
  }
}

function computeRevisitDate(option: string, customDate: string, decisionDate: string): string | undefined {
  if (option === 'never') return undefined
  if (option === 'custom') return customDate || undefined
  const days = option === '30' ? 30 : 90
  const date = new Date(decisionDate + 'T00:00:00')
  date.setDate(date.getDate() + days)
  return date.toISOString().split('T')[0]
}

function revisitStatusBadge(status: RevisitStatus) {
  switch (status) {
    case 'pending':
      return <Badge variant="outline" className="border-amber-500 text-amber-600">Pending Review</Badge>
    case 'validated':
      return <Badge variant="outline" className="border-green-500 text-green-600">Validated</Badge>
    case 'reversed':
      return <Badge variant="outline" className="border-red-500 text-red-600">Reversed</Badge>
  }
}

export function NotesPage() {
  const { items: allNotes, isLoading, create, update, remove } = useEntities('note')
  const { items: allProjects } = useEntities('project')
  const { items: allGoals } = useEntities('goal')
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

  // Decision state
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>('all')
  const [decisionDialogOpen, setDecisionDialogOpen] = useState(false)
  const [decisionForm, setDecisionForm] = useState<DecisionFormState>(emptyDecisionForm)
  const [newAlternative, setNewAlternative] = useState('')
  const [viewingDecision, setViewingDecision] = useState<Entity | null>(null)
  const [editingDecision, setEditingDecision] = useState<Entity | null>(null)
  const [editDecisionForm, setEditDecisionForm] = useState<DecisionFormState>(emptyDecisionForm)
  const [editNewAlternative, setEditNewAlternative] = useState('')

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
    let filtered = allNotes.filter((n) => !n.metadata.isJournal && !n.metadata.isInbox && !n.metadata.isDecision)
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

  // Decisions
  const decisions = useMemo(() => {
    let filtered = allNotes.filter((n) => n.metadata.isDecision)
    if (decisionFilter !== 'all') {
      filtered = filtered.filter((n) => n.metadata.revisitStatus === decisionFilter)
    }
    return filtered.sort((a, b) => {
      const dateA = (a.metadata.decisionDate as string) || a.createdAt
      const dateB = (b.metadata.decisionDate as string) || b.createdAt
      return dateB.localeCompare(dateA)
    })
  }, [allNotes, decisionFilter])

  const activeProjects = useMemo(
    () => allProjects.filter((p) => p.status !== 'archived'),
    [allProjects],
  )
  const activeGoals = useMemo(
    () => allGoals.filter((g) => g.status !== 'archived'),
    [allGoals],
  )

  const today = new Date().toISOString().split('T')[0]

  const isDueForRevisit = (decision: Entity) => {
    const revisitDate = decision.metadata.revisitDate as string | undefined
    const revisitStatus = decision.metadata.revisitStatus as RevisitStatus | undefined
    return revisitDate && revisitDate <= today && revisitStatus === 'pending'
  }

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

  const handleCreateDecision = () => {
    if (!decisionForm.title.trim()) return
    const revisitDate = computeRevisitDate(decisionForm.revisitOption, decisionForm.revisitDate, decisionForm.decisionDate)
    create.mutate({
      id: crypto.randomUUID(),
      type: 'note',
      title: decisionForm.title,
      description: '',
      status: 'todo' as EntityStatus,
      priority: 'medium' as Entity['priority'],
      tags: [],
      metadata: {
        isDecision: true,
        body: decisionForm.body,
        reasoning: decisionForm.reasoning,
        alternatives: decisionForm.alternatives,
        linkedProjectId: decisionForm.linkedProjectId || undefined,
        linkedGoalId: decisionForm.linkedGoalId || undefined,
        revisitDate,
        revisitStatus: revisitDate ? 'pending' : undefined,
        decisionDate: decisionForm.decisionDate,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    setDecisionDialogOpen(false)
    setDecisionForm(emptyDecisionForm())
    setNewAlternative('')
    notify({ title: 'Decision recorded', type: 'success' })
  }

  const openEditDecision = (decision: Entity) => {
    const m = decision.metadata
    const revisitDate = (m.revisitDate as string) || ''
    const decisionDate = (m.decisionDate as string) || today
    let revisitOption: DecisionFormState['revisitOption'] = 'never'
    if (revisitDate) {
      // Try to detect 30/90, otherwise custom
      const d = new Date(decisionDate + 'T00:00:00')
      const r = new Date(revisitDate + 'T00:00:00')
      const diff = Math.round((r.getTime() - d.getTime()) / (1000 * 60 * 60 * 24))
      if (diff === 30) revisitOption = '30'
      else if (diff === 90) revisitOption = '90'
      else revisitOption = 'custom'
    }
    setEditDecisionForm({
      title: decision.title,
      body: (m.body as string) || '',
      reasoning: (m.reasoning as string) || '',
      alternatives: Array.isArray(m.alternatives) ? (m.alternatives as string[]) : [],
      linkedProjectId: (m.linkedProjectId as string) || '',
      linkedGoalId: (m.linkedGoalId as string) || '',
      revisitOption,
      revisitDate,
      decisionDate,
    })
    setEditingDecision(decision)
    setEditNewAlternative('')
  }

  const handleSaveDecision = () => {
    if (!editingDecision) return
    const revisitDate = computeRevisitDate(editDecisionForm.revisitOption, editDecisionForm.revisitDate, editDecisionForm.decisionDate)
    update.mutate({
      id: editingDecision.id,
      updates: {
        title: editDecisionForm.title,
        metadata: {
          ...editingDecision.metadata,
          body: editDecisionForm.body,
          reasoning: editDecisionForm.reasoning,
          alternatives: editDecisionForm.alternatives,
          linkedProjectId: editDecisionForm.linkedProjectId || undefined,
          linkedGoalId: editDecisionForm.linkedGoalId || undefined,
          revisitDate,
          decisionDate: editDecisionForm.decisionDate,
        },
        updatedAt: new Date().toISOString(),
      },
    })
    setEditingDecision(null)
    notify({ title: 'Decision updated', type: 'success' })
  }

  const handleRevisitStatus = (decision: Entity, status: RevisitStatus) => {
    update.mutate({
      id: decision.id,
      updates: {
        metadata: { ...decision.metadata, revisitStatus: status },
        updatedAt: new Date().toISOString(),
      },
    })
    if (viewingDecision?.id === decision.id) {
      setViewingDecision({ ...decision, metadata: { ...decision.metadata, revisitStatus: status } })
    }
    notify({ title: `Decision ${status}`, type: 'success' })
  }

  const getLinkedName = (id: string | undefined, list: Entity[]) => {
    if (!id) return null
    return list.find((e) => e.id === id)?.title ?? null
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
          <TabsTrigger value="decisions">Decisions</TabsTrigger>
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

        <TabsContent value="decisions" className="space-y-4">
          {/* Decisions header */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <Select
              value={decisionFilter}
              onValueChange={(v) => setDecisionFilter(v as DecisionFilter)}
            >
              <SelectTrigger className="w-[170px]">
                <SelectValue placeholder="Filter decisions" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Decisions</SelectItem>
                <SelectItem value="pending">Pending Review</SelectItem>
                <SelectItem value="validated">Validated</SelectItem>
                <SelectItem value="reversed">Reversed</SelectItem>
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={() => {
                setDecisionForm(emptyDecisionForm())
                setNewAlternative('')
                setDecisionDialogOpen(true)
              }}
            >
              <Plus className="h-4 w-4 mr-1" /> New Decision
            </Button>
          </div>

          {/* Decision cards */}
          {decisions.length === 0 ? (
            <EmptyState
              icon={Scale}
              title="No decisions yet"
              description="Start tracking strategic decisions and their outcomes."
              actionLabel="New Decision"
              onAction={() => {
                setDecisionForm(emptyDecisionForm())
                setNewAlternative('')
                setDecisionDialogOpen(true)
              }}
            />
          ) : (
            <div className="space-y-3">
              {decisions.map((decision) => {
                const alternatives = Array.isArray(decision.metadata.alternatives)
                  ? (decision.metadata.alternatives as string[])
                  : []
                const revisitDate = decision.metadata.revisitDate as string | undefined
                const revisitStatus = (decision.metadata.revisitStatus as RevisitStatus) || 'pending'
                const linkedProject = getLinkedName(decision.metadata.linkedProjectId as string | undefined, allProjects)
                const linkedGoal = getLinkedName(decision.metadata.linkedGoalId as string | undefined, allGoals)
                const dueForRevisit = isDueForRevisit(decision)

                return (
                  <Card
                    key={decision.id}
                    className={`cursor-pointer transition-colors hover:bg-muted/50 ${dueForRevisit ? 'border-amber-500 border-2' : ''}`}
                    onClick={() => setViewingDecision(decision)}
                  >
                    <CardContent className="py-3 space-y-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="space-y-1 min-w-0">
                          <h4 className="text-sm font-bold truncate">{decision.title}</h4>
                          <p className="text-xs text-muted-foreground">
                            {new Date((decision.metadata.decisionDate as string) + 'T00:00:00').toLocaleDateString(undefined, {
                              year: 'numeric',
                              month: 'short',
                              day: 'numeric',
                            })}
                          </p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          {revisitDate && revisitStatusBadge(revisitStatus)}
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            onClick={(e) => {
                              e.stopPropagation()
                              openEditDecision(decision)
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="h-7 px-2"
                            onClick={(e) => {
                              e.stopPropagation()
                              setDeleteTarget(decision)
                            }}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                      {typeof decision.metadata.reasoning === 'string' && decision.metadata.reasoning && (
                        <p className="text-xs text-muted-foreground line-clamp-2">
                          {decision.metadata.reasoning}
                        </p>
                      )}
                      <div className="flex items-center gap-2 flex-wrap">
                        {alternatives.length > 0 && (
                          <span className="text-xs text-muted-foreground">
                            {alternatives.length} alternative{alternatives.length !== 1 ? 's' : ''} considered
                          </span>
                        )}
                        {linkedProject && (
                          <Badge variant="secondary" className="text-xs">
                            {linkedProject}
                          </Badge>
                        )}
                        {linkedGoal && (
                          <Badge variant="secondary" className="text-xs">
                            {linkedGoal}
                          </Badge>
                        )}
                        {revisitDate && (
                          <span className="text-xs text-muted-foreground ml-auto">
                            Review: {new Date(revisitDate + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}
                          </span>
                        )}
                      </div>
                    </CardContent>
                  </Card>
                )
              })}
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

      {/* Decision Create Dialog */}
      <Dialog open={decisionDialogOpen} onOpenChange={setDecisionDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Decision</DialogTitle>
            <DialogDescription>Record a strategic decision for future review.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="decision-title">Title</Label>
              <Input
                id="decision-title"
                placeholder="Decision title"
                value={decisionForm.title}
                onChange={(e) => setDecisionForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="decision-body">What was decided</Label>
              <Textarea
                id="decision-body"
                placeholder="Describe the decision..."
                value={decisionForm.body}
                onChange={(e) => setDecisionForm((f) => ({ ...f, body: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="decision-reasoning">Why</Label>
              <Textarea
                id="decision-reasoning"
                placeholder="Reasoning behind this decision..."
                value={decisionForm.reasoning}
                onChange={(e) => setDecisionForm((f) => ({ ...f, reasoning: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Alternatives considered</Label>
              <div className="space-y-1">
                {decisionForm.alternatives.map((alt, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-sm flex-1 truncate">{alt}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1"
                      onClick={() =>
                        setDecisionForm((f) => ({
                          ...f,
                          alternatives: f.alternatives.filter((_, idx) => idx !== i),
                        }))
                      }
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Add alternative..."
                  value={newAlternative}
                  onChange={(e) => setNewAlternative(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newAlternative.trim()) {
                      e.preventDefault()
                      setDecisionForm((f) => ({
                        ...f,
                        alternatives: [...f.alternatives, newAlternative.trim()],
                      }))
                      setNewAlternative('')
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!newAlternative.trim()}
                  onClick={() => {
                    if (newAlternative.trim()) {
                      setDecisionForm((f) => ({
                        ...f,
                        alternatives: [...f.alternatives, newAlternative.trim()],
                      }))
                      setNewAlternative('')
                    }
                  }}
                >
                  Add
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Link to project</Label>
                <Select
                  value={decisionForm.linkedProjectId || '_none'}
                  onValueChange={(v) => setDecisionForm((f) => ({ ...f, linkedProjectId: v === '_none' ? '' : v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">None</SelectItem>
                    {activeProjects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Link to goal</Label>
                <Select
                  value={decisionForm.linkedGoalId || '_none'}
                  onValueChange={(v) => setDecisionForm((f) => ({ ...f, linkedGoalId: v === '_none' ? '' : v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">None</SelectItem>
                    {activeGoals.map((g) => (
                      <SelectItem key={g.id} value={g.id}>{g.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="decision-date">Decision date</Label>
                <Input
                  id="decision-date"
                  type="date"
                  value={decisionForm.decisionDate}
                  onChange={(e) => setDecisionForm((f) => ({ ...f, decisionDate: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Revisit in</Label>
                <Select
                  value={decisionForm.revisitOption}
                  onValueChange={(v) => setDecisionForm((f) => ({ ...f, revisitOption: v as DecisionFormState['revisitOption'] }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="30">30 days</SelectItem>
                    <SelectItem value="90">90 days</SelectItem>
                    <SelectItem value="custom">Custom date</SelectItem>
                    <SelectItem value="never">Never</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {decisionForm.revisitOption === 'custom' && (
              <div className="space-y-2">
                <Label htmlFor="revisit-date">Custom revisit date</Label>
                <Input
                  id="revisit-date"
                  type="date"
                  value={decisionForm.revisitDate}
                  onChange={(e) => setDecisionForm((f) => ({ ...f, revisitDate: e.target.value }))}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDecisionDialogOpen(false)}>Cancel</Button>
            <Button onClick={handleCreateDecision} disabled={!decisionForm.title.trim()}>
              Record Decision
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Decision View Dialog */}
      <Dialog open={!!viewingDecision} onOpenChange={(open) => !open && setViewingDecision(null)}>
        {viewingDecision && (
          <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{viewingDecision.title}</DialogTitle>
              <DialogDescription>
                Decided on{' '}
                {new Date(((viewingDecision.metadata.decisionDate as string) || '') + 'T00:00:00').toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'long',
                  day: 'numeric',
                })}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              {typeof viewingDecision.metadata.body === 'string' && viewingDecision.metadata.body && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">What was decided</Label>
                  <p className="text-sm">{viewingDecision.metadata.body}</p>
                </div>
              )}
              {typeof viewingDecision.metadata.reasoning === 'string' && viewingDecision.metadata.reasoning && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Reasoning</Label>
                  <p className="text-sm">{viewingDecision.metadata.reasoning}</p>
                </div>
              )}
              {Array.isArray(viewingDecision.metadata.alternatives) && (viewingDecision.metadata.alternatives as string[]).length > 0 && (
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">Alternatives considered</Label>
                  <ul className="list-disc list-inside space-y-1">
                    {(viewingDecision.metadata.alternatives as string[]).map((alt, i) => (
                      <li key={i} className="text-sm">{alt}</li>
                    ))}
                  </ul>
                </div>
              )}
              <div className="flex gap-4 flex-wrap">
                {getLinkedName(viewingDecision.metadata.linkedProjectId as string | undefined, allProjects) && (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Linked project</Label>
                    <p className="text-sm">{getLinkedName(viewingDecision.metadata.linkedProjectId as string | undefined, allProjects)}</p>
                  </div>
                )}
                {getLinkedName(viewingDecision.metadata.linkedGoalId as string | undefined, allGoals) && (
                  <div className="space-y-1">
                    <Label className="text-xs text-muted-foreground">Linked goal</Label>
                    <p className="text-sm">{getLinkedName(viewingDecision.metadata.linkedGoalId as string | undefined, allGoals)}</p>
                  </div>
                )}
              </div>
              {typeof viewingDecision.metadata.revisitDate === 'string' && viewingDecision.metadata.revisitDate && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Label className="text-xs text-muted-foreground">Review status</Label>
                    {revisitStatusBadge((viewingDecision.metadata.revisitStatus as RevisitStatus) || 'pending')}
                    <span className="text-xs text-muted-foreground ml-auto">
                      Due: {new Date(((viewingDecision.metadata.revisitDate as string) || '') + 'T00:00:00').toLocaleDateString()}
                    </span>
                  </div>
                  {(viewingDecision.metadata.revisitStatus as string) === 'pending' && (
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-green-500 text-green-600 hover:bg-green-50"
                        onClick={() => handleRevisitStatus(viewingDecision, 'validated')}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Validate
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-red-500 text-red-600 hover:bg-red-50"
                        onClick={() => handleRevisitStatus(viewingDecision, 'reversed')}
                      >
                        <XCircle className="h-3.5 w-3.5 mr-1" /> Reverse
                      </Button>
                    </div>
                  )}
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => {
                  setViewingDecision(null)
                  openEditDecision(viewingDecision)
                }}
              >
                <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
              </Button>
              <Button variant="outline" onClick={() => setViewingDecision(null)}>Close</Button>
            </DialogFooter>
          </DialogContent>
        )}
      </Dialog>

      {/* Decision Edit Dialog */}
      <Dialog open={!!editingDecision} onOpenChange={(open) => !open && setEditingDecision(null)}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Edit Decision</DialogTitle>
            <DialogDescription>Update the decision details.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-decision-title">Title</Label>
              <Input
                id="edit-decision-title"
                value={editDecisionForm.title}
                onChange={(e) => setEditDecisionForm((f) => ({ ...f, title: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-decision-body">What was decided</Label>
              <Textarea
                id="edit-decision-body"
                value={editDecisionForm.body}
                onChange={(e) => setEditDecisionForm((f) => ({ ...f, body: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-decision-reasoning">Why</Label>
              <Textarea
                id="edit-decision-reasoning"
                value={editDecisionForm.reasoning}
                onChange={(e) => setEditDecisionForm((f) => ({ ...f, reasoning: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Alternatives considered</Label>
              <div className="space-y-1">
                {editDecisionForm.alternatives.map((alt, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <span className="text-sm flex-1 truncate">{alt}</span>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-6 px-1"
                      onClick={() =>
                        setEditDecisionForm((f) => ({
                          ...f,
                          alternatives: f.alternatives.filter((_, idx) => idx !== i),
                        }))
                      }
                    >
                      <X className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
              <div className="flex gap-2">
                <Input
                  placeholder="Add alternative..."
                  value={editNewAlternative}
                  onChange={(e) => setEditNewAlternative(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && editNewAlternative.trim()) {
                      e.preventDefault()
                      setEditDecisionForm((f) => ({
                        ...f,
                        alternatives: [...f.alternatives, editNewAlternative.trim()],
                      }))
                      setEditNewAlternative('')
                    }
                  }}
                />
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!editNewAlternative.trim()}
                  onClick={() => {
                    if (editNewAlternative.trim()) {
                      setEditDecisionForm((f) => ({
                        ...f,
                        alternatives: [...f.alternatives, editNewAlternative.trim()],
                      }))
                      setEditNewAlternative('')
                    }
                  }}
                >
                  Add
                </Button>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Link to project</Label>
                <Select
                  value={editDecisionForm.linkedProjectId || '_none'}
                  onValueChange={(v) => setEditDecisionForm((f) => ({ ...f, linkedProjectId: v === '_none' ? '' : v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">None</SelectItem>
                    {activeProjects.map((p) => (
                      <SelectItem key={p.id} value={p.id}>{p.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Link to goal</Label>
                <Select
                  value={editDecisionForm.linkedGoalId || '_none'}
                  onValueChange={(v) => setEditDecisionForm((f) => ({ ...f, linkedGoalId: v === '_none' ? '' : v }))}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="None" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_none">None</SelectItem>
                    {activeGoals.map((g) => (
                      <SelectItem key={g.id} value={g.id}>{g.title}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="edit-decision-date">Decision date</Label>
                <Input
                  id="edit-decision-date"
                  type="date"
                  value={editDecisionForm.decisionDate}
                  onChange={(e) => setEditDecisionForm((f) => ({ ...f, decisionDate: e.target.value }))}
                />
              </div>
              <div className="space-y-2">
                <Label>Revisit in</Label>
                <Select
                  value={editDecisionForm.revisitOption}
                  onValueChange={(v) => setEditDecisionForm((f) => ({ ...f, revisitOption: v as DecisionFormState['revisitOption'] }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="30">30 days</SelectItem>
                    <SelectItem value="90">90 days</SelectItem>
                    <SelectItem value="custom">Custom date</SelectItem>
                    <SelectItem value="never">Never</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {editDecisionForm.revisitOption === 'custom' && (
              <div className="space-y-2">
                <Label htmlFor="edit-revisit-date">Custom revisit date</Label>
                <Input
                  id="edit-revisit-date"
                  type="date"
                  value={editDecisionForm.revisitDate}
                  onChange={(e) => setEditDecisionForm((f) => ({ ...f, revisitDate: e.target.value }))}
                />
              </div>
            )}
            {typeof editingDecision?.metadata.revisitDate === 'string' && editingDecision.metadata.revisitDate && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">Review status</Label>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-green-500 text-green-600 hover:bg-green-50"
                    onClick={() => {
                      if (editingDecision) handleRevisitStatus(editingDecision, 'validated')
                    }}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1" /> Validate
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="border-red-500 text-red-600 hover:bg-red-50"
                    onClick={() => {
                      if (editingDecision) handleRevisitStatus(editingDecision, 'reversed')
                    }}
                  >
                    <XCircle className="h-3.5 w-3.5 mr-1" /> Reverse
                  </Button>
                </div>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditingDecision(null)}>Cancel</Button>
            <Button onClick={handleSaveDecision} disabled={!editDecisionForm.title.trim()}>
              Save Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
