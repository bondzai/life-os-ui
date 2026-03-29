import { useState, useMemo, useEffect, useCallback } from 'react'
import { useSearchParams, useNavigate } from 'react-router'
import {
  Plus,
  FolderKanban,
  Pencil,
  Trash2,
  ChevronLeft,
  ExternalLink,
  Target,
  CheckSquare,
  NotebookPen,
  Search,
  X,
  LinkIcon,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { ViewToggle } from '@/components/view-toggle'
import { useEntities, useRelations } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { EntityDetail } from '@/core/components/entity-detail'
import { StatusBadge } from '@/core/components/status-badge'
import { PriorityBadge } from '@/core/components/priority-badge'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import { VelocityPanel } from '@/pages/goals/velocity-panel'
import { AIAction } from '@/components/ai-action'
import type { Entity, EntityStatus, EntityPriority } from '@/core/types'
import { isGoal, isTask } from '@/core/types'

/* ─── Category config ─── */

const CATEGORIES = ['software', 'business', 'creative', 'learning', 'lifestyle'] as const
type ProjectCategory = (typeof CATEGORIES)[number]

const DOMAINS = ['work', 'personal', 'side-project'] as const

const categoryColors: Record<ProjectCategory, string> = {
  software: 'bg-blue-500/10 text-blue-600 dark:text-blue-400',
  business: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400',
  creative: 'bg-purple-500/10 text-purple-600 dark:text-purple-400',
  learning: 'bg-amber-500/10 text-amber-600 dark:text-amber-400',
  lifestyle: 'bg-pink-500/10 text-pink-600 dark:text-pink-400',
}

const categoryEmoji: Record<ProjectCategory, string> = {
  software: '💻',
  business: '📈',
  creative: '🎨',
  learning: '📚',
  lifestyle: '🏡',
}

const domainLabels: Record<string, string> = {
  work: 'Work',
  personal: 'Personal',
  'side-project': 'Side Project',
}

const statusLabels: Record<string, string> = {
  'in-progress': 'Active',
  todo: 'Planned',
  done: 'Completed',
  backlog: 'Backlog',
  archived: 'Archived',
}

/* ─── Metadata helpers ─── */

function getCategory(project: Entity): ProjectCategory {
  const cat = project.metadata?.category as string | undefined
  return CATEGORIES.includes(cat as ProjectCategory) ? (cat as ProjectCategory) : 'lifestyle'
}

function getDomain(project: Entity): string {
  return (project.metadata?.domain as string) ?? 'personal'
}

function getStack(project: Entity): string[] {
  const s = project.metadata?.stack
  return Array.isArray(s) ? (s as string[]) : []
}

function getLinks(project: Entity): Array<{ label: string; url: string }> {
  const l = project.metadata?.links
  return Array.isArray(l) ? (l as Array<{ label: string; url: string }>) : []
}

function getSummary(project: Entity): string {
  return (project.metadata?.summary as string) ?? ''
}

/* ─── Persistence ─── */

const VIEW_KEY = 'lyra:projects-view'
function getSavedView(): 'grid' | 'list' {
  try { return (localStorage.getItem(VIEW_KEY) as 'grid' | 'list') ?? 'grid' } catch { return 'grid' }
}

/* ─── Project Create Dialog ─── */

function ProjectCreateDialog({
  open,
  onOpenChange,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmit: (values: {
    title: string
    description: string
    status: EntityStatus
    priority: EntityPriority
    category: ProjectCategory
    domain: string
    stack: string[]
    summary: string
    links: Array<{ label: string; url: string }>
  }) => void
}) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [status, setStatus] = useState<EntityStatus>('in-progress')
  const [priority, setPriority] = useState<EntityPriority>('medium')
  const [category, setCategory] = useState<ProjectCategory>('software')
  const [domain, setDomain] = useState('personal')
  const [stackInput, setStackInput] = useState('')
  const [summary, setSummary] = useState('')
  const [linkLabel, setLinkLabel] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const [links, setLinks] = useState<Array<{ label: string; url: string }>>([])

  useEffect(() => {
    if (open) {
      setTitle('')
      setDescription('')
      setStatus('in-progress')
      setPriority('medium')
      setCategory('software')
      setDomain('personal')
      setStackInput('')
      setSummary('')
      setLinkLabel('')
      setLinkUrl('')
      setLinks([])
    }
  }, [open])

  const handleSubmit = () => {
    if (!title.trim()) return
    const stack = stackInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    onSubmit({ title: title.trim(), description: description.trim(), status, priority, category, domain, stack, summary: summary.trim(), links })
    onOpenChange(false)
  }

  const addLink = () => {
    if (!linkLabel.trim() || !linkUrl.trim()) return
    setLinks((prev) => [...prev, { label: linkLabel.trim(), url: linkUrl.trim() }])
    setLinkLabel('')
    setLinkUrl('')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderKanban className="h-4 w-4" />
            New Project
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label>Title</Label>
            <Input
              placeholder="e.g. Life OS UI, Trading Bot, Home Renovation"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div>
            <Label>Summary</Label>
            <Input
              placeholder="One-liner for AI context"
              value={summary}
              onChange={(e) => setSummary(e.target.value)}
            />
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <Label>Category</Label>
              <Select value={category} onValueChange={(v) => setCategory(v as ProjectCategory)}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {CATEGORIES.map((c) => (
                    <SelectItem key={c} value={c}>
                      {categoryEmoji[c]} {c.charAt(0).toUpperCase() + c.slice(1)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Domain</Label>
              <Select value={domain} onValueChange={setDomain}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DOMAINS.map((d) => (
                    <SelectItem key={d} value={d}>{domainLabels[d]}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Status</Label>
              <Select value={status} onValueChange={(v) => setStatus(v as EntityStatus)}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="in-progress">Active</SelectItem>
                  <SelectItem value="todo">Planned</SelectItem>
                  <SelectItem value="backlog">Backlog</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Priority</Label>
              <Select value={priority} onValueChange={(v) => setPriority(v as EntityPriority)}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label>Tech Stack (comma-separated)</Label>
            <Input
              placeholder="React, TypeScript, Node.js"
              value={stackInput}
              onChange={(e) => setStackInput(e.target.value)}
            />
          </div>

          <div>
            <Label>Description</Label>
            <Textarea
              placeholder="What is this project about?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>

          {/* Links */}
          <div className="space-y-2">
            <Label>Links</Label>
            {links.length > 0 && (
              <div className="space-y-1">
                {links.map((link, i) => (
                  <div key={i} className="flex items-center gap-2 text-xs">
                    <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate">{link.label}: {link.url}</span>
                    <button onClick={() => setLinks((prev) => prev.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-foreground">
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-1.5">
              <Input placeholder="Label" value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} className="h-7 text-xs flex-1" />
              <Input placeholder="URL" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} className="h-7 text-xs flex-[2]"
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addLink() } }}
              />
              <Button type="button" variant="outline" size="sm" className="h-7 shrink-0" onClick={addLink} disabled={!linkLabel.trim() || !linkUrl.trim()}>
                <Plus className="h-3 w-3" />
              </Button>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSubmit} disabled={!title.trim()}>Create Project</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

/* ─── Inline Metadata Editor ─── */

function MetadataEditor({
  project,
  onUpdate,
}: {
  project: Entity
  onUpdate: (id: string, updates: Partial<Entity>) => void
}) {
  const category = getCategory(project)
  const domain = getDomain(project)
  const stack = getStack(project)
  const summary = getSummary(project)
  const links = getLinks(project)

  const [stackInput, setStackInput] = useState(stack.join(', '))
  const [summaryInput, setSummaryInput] = useState(summary)
  const [linkLabel, setLinkLabel] = useState('')
  const [linkUrl, setLinkUrl] = useState('')

  const save = useCallback(
    (meta: Record<string, unknown>) => {
      onUpdate(project.id, { metadata: { ...project.metadata, ...meta }, updatedAt: new Date().toISOString() })
    },
    [project, onUpdate],
  )

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="text-xs text-muted-foreground">Category</Label>
          <Select value={category} onValueChange={(v) => save({ category: v })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {categoryEmoji[c]} {c.charAt(0).toUpperCase() + c.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Domain</Label>
          <Select value={domain} onValueChange={(v) => save({ domain: v })}>
            <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
            <SelectContent>
              {DOMAINS.map((d) => (
                <SelectItem key={d} value={d}>{domainLabels[d]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <Label className="text-xs text-muted-foreground">Summary</Label>
        <Input
          className="h-8 text-xs"
          value={summaryInput}
          onChange={(e) => setSummaryInput(e.target.value)}
          onBlur={() => save({ summary: summaryInput })}
          placeholder="One-liner for AI context"
        />
      </div>

      <div>
        <Label className="text-xs text-muted-foreground">Tech Stack</Label>
        <Input
          className="h-8 text-xs"
          value={stackInput}
          onChange={(e) => setStackInput(e.target.value)}
          onBlur={() => save({ stack: stackInput.split(',').map((s) => s.trim()).filter(Boolean) })}
          placeholder="React, TypeScript, Node.js"
        />
      </div>

      {/* Links */}
      <div className="space-y-1.5">
        <Label className="text-xs text-muted-foreground">Links</Label>
        {links.map((link, i) => (
          <div key={i} className="flex items-center gap-2">
            <a href={link.url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-primary hover:underline flex-1 truncate">
              <ExternalLink className="h-3 w-3 shrink-0" />
              {link.label}
            </a>
            <button
              onClick={() => {
                const updated = links.filter((_, j) => j !== i)
                save({ links: updated })
              }}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        ))}
        <div className="flex gap-1.5">
          <Input placeholder="Label" value={linkLabel} onChange={(e) => setLinkLabel(e.target.value)} className="h-7 text-xs flex-1" />
          <Input placeholder="URL" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} className="h-7 text-xs flex-[2]"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                if (linkLabel.trim() && linkUrl.trim()) {
                  save({ links: [...links, { label: linkLabel.trim(), url: linkUrl.trim() }] })
                  setLinkLabel('')
                  setLinkUrl('')
                }
              }
            }}
          />
          <Button
            type="button" variant="outline" size="sm" className="h-7 shrink-0"
            onClick={() => {
              if (linkLabel.trim() && linkUrl.trim()) {
                save({ links: [...links, { label: linkLabel.trim(), url: linkUrl.trim() }] })
                setLinkLabel('')
                setLinkUrl('')
              }
            }}
            disabled={!linkLabel.trim() || !linkUrl.trim()}
          >
            <LinkIcon className="h-3 w-3" />
          </Button>
        </div>
      </div>
    </div>
  )
}

/* ─── Page ─── */

export function ProjectsPage() {
  const { items: allEntities, isLoading, create, update, remove } = useEntities()
  const { items: allRelations } = useRelations()
  const currentUser = useAuthStore((s) => s.currentUser)
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()

  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'all'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(getSavedView)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingProject, setEditingProject] = useState<Entity | null>(null)
  const [selectedProject, setSelectedProject] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)

  const allProjects = useMemo(
    () => allEntities.filter((e) => isGoal(e)),
    [allEntities],
  )

  // Auto-select from URL param ?id=project-1
  useEffect(() => {
    const id = searchParams.get('id')
    if (id && allProjects.length > 0 && !selectedProject) {
      const p = allProjects.find((e) => e.id === id)
      if (p) {
        setSelectedProject(p)
        searchParams.delete('id')
        setSearchParams(searchParams, { replace: true })
      }
    }
  }, [searchParams, allProjects, selectedProject, setSearchParams])

  const handleViewChange = (mode: 'grid' | 'list') => {
    setViewMode(mode)
    try { localStorage.setItem(VIEW_KEY, mode) } catch { /* noop */ }
  }

  const projects = useMemo(() => {
    let filtered = allProjects
    if (statusFilter !== 'all') {
      filtered = filtered.filter((p) => p.status === statusFilter)
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase()
      filtered = filtered.filter(
        (p) =>
          p.title.toLowerCase().includes(q) ||
          p.description?.toLowerCase().includes(q) ||
          getStack(p).some((s) => s.toLowerCase().includes(q)) ||
          getCategory(p).includes(q) ||
          p.tags.some((t) => t.toLowerCase().includes(q)),
      )
    }
    return filtered
  }, [allProjects, statusFilter, searchQuery])

  // Linked tasks for a project
  const getLinkedTasks = useCallback(
    (projectId: string) =>
      allEntities.filter(
        (e) => isTask(e) && e.status !== 'archived' && e.metadata?.projectId === projectId,
      ),
    [allEntities],
  )

  // Linked goals via relations
  const getLinkedGoals = useCallback(
    (projectId: string) => {
      const goalIds = allRelations
        .filter((r) => (r.fromId === projectId || r.toId === projectId) && (r.type === 'supports' || r.type === 'relates'))
        .map((r) => (r.fromId === projectId ? r.toId : r.fromId))
      return allEntities.filter((e) => isGoal(e) && goalIds.includes(e.id))
    },
    [allEntities, allRelations],
  )

  // Linked notes
  const getLinkedNotes = useCallback(
    (projectId: string) => {
      const noteIds = allRelations
        .filter((r) => (r.fromId === projectId || r.toId === projectId) && r.type === 'relates')
        .map((r) => (r.fromId === projectId ? r.toId : r.fromId))
      return allEntities.filter((e) => e.type === 'note' && noteIds.includes(e.id))
    },
    [allEntities, allRelations],
  )

  // Progress from linked tasks
  const getProgress = useCallback(
    (projectId: string) => {
      const tasks = getLinkedTasks(projectId)
      if (tasks.length === 0) return 0
      const done = tasks.filter((t) => t.status === 'done').length
      return Math.round((done / tasks.length) * 100)
    },
    [getLinkedTasks],
  )

  // Group projects by status
  const grouped = useMemo(() => {
    const groups: Record<string, Entity[]> = { 'in-progress': [], todo: [], done: [], backlog: [], archived: [] }
    for (const p of projects) {
      const g = groups[p.status]
      if (g) g.push(p)
    }
    return Object.entries(groups).filter(([, items]) => items.length > 0)
  }, [projects])

  const handleCreate = (values: {
    title: string; description: string; status: EntityStatus; priority: EntityPriority
    category: ProjectCategory; domain: string; stack: string[]; summary: string
    links: Array<{ label: string; url: string }>
  }) => {
    create.mutate({
      id: crypto.randomUUID(),
      type: 'project',
      title: values.title,
      description: values.description || undefined,
      status: values.status,
      priority: values.priority,
      tags: [],
      metadata: {
        category: values.category,
        domain: values.domain,
        stack: values.stack,
        links: values.links,
        summary: values.summary,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Project created', type: 'success' })
  }

  const handleEdit = (values: Record<string, unknown>) => {
    if (!editingProject) return
    const tags = typeof values.tags === 'string'
      ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : []
    update.mutate({
      id: editingProject.id,
      updates: {
        title: values.title as string,
        description: (values.description as string) || undefined,
        status: values.status as EntityStatus,
        priority: values.priority as Entity['priority'],
        tags,
        dueDate: (values.dueDate as string) || undefined,
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Project updated', type: 'success' })
    setEditingProject(null)
  }

  const handleUpdate = useCallback(
    (id: string, updates: Partial<Entity>) => {
      update.mutate({ id, updates })
    },
    [update],
  )

  const handleQuickStatus = useCallback(
    (project: Entity, newStatus: EntityStatus) => {
      update.mutate({
        id: project.id,
        updates: { status: newStatus, updatedAt: new Date().toISOString() },
      })
      notify({ title: `Project ${statusLabels[newStatus]?.toLowerCase() ?? newStatus}`, type: 'success' })
    },
    [update],
  )

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  /* ─── Detail View ─── */

  if (selectedProject) {
    const fresh = allProjects.find((p) => p.id === selectedProject.id) ?? selectedProject
    const tasks = getLinkedTasks(fresh.id)
    const goals = getLinkedGoals(fresh.id)
    const notes = getLinkedNotes(fresh.id)
    const progress = getProgress(fresh.id)

    const tasksByStatus = {
      'in-progress': tasks.filter((t) => t.status === 'in-progress'),
      todo: tasks.filter((t) => t.status === 'todo'),
      done: tasks.filter((t) => t.status === 'done'),
      backlog: tasks.filter((t) => t.status === 'backlog'),
    }

    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setSelectedProject(null)}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Back to projects
        </Button>

        <EntityDetail entity={fresh} showComments currentUserId={currentUser?.id}>
          <div className="space-y-5">
            {/* Inline metadata editor */}
            <MetadataEditor project={fresh} onUpdate={handleUpdate} />

            {/* Progress */}
            <div className="space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">Progress</span>
                <span className="font-medium tabular-nums">{progress}%</span>
              </div>
              <Progress value={progress} />
              <p className="text-xs text-muted-foreground">
                {tasks.filter((t) => t.status === 'done').length}/{tasks.length} tasks completed
              </p>
            </div>

            {/* Velocity */}
            <VelocityPanel entityId={fresh.id} entityType="goal" dueDate={fresh.dueDate} />

            <AIAction tool="analyze-risk" entityId={fresh.id} label="Risk Analysis" />

            {/* Tasks by status */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium flex items-center gap-1.5">
                <CheckSquare className="h-3.5 w-3.5" /> Tasks
              </h4>
              {tasks.length === 0 ? (
                <p className="text-xs text-muted-foreground">No tasks linked. Set project on a task to link it here.</p>
              ) : (
                Object.entries(tasksByStatus)
                  .filter(([, items]) => items.length > 0)
                  .map(([status, items]) => (
                    <div key={status}>
                      <p className="text-xs text-muted-foreground/60 uppercase tracking-wider mb-1">
                        {statusLabels[status] ?? status} ({items.length})
                      </p>
                      <div className="space-y-0.5">
                        {items.map((task) => (
                          <button
                            key={task.id}
                            onClick={() => navigate(`/tasks?id=${task.id}`)}
                            className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/40 transition-colors"
                          >
                            <CheckSquare className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                            <span className={`flex-1 truncate ${task.status === 'done' ? 'line-through text-muted-foreground' : ''}`}>
                              {task.title}
                            </span>
                            <PriorityBadge priority={task.priority} />
                          </button>
                        ))}
                      </div>
                    </div>
                  ))
              )}
            </div>

            {/* Linked Goals */}
            {goals.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-1.5">
                  <Target className="h-3.5 w-3.5" /> Linked Goals
                </h4>
                {goals.map((goal) => (
                  <button
                    key={goal.id}
                    onClick={() => navigate(`/goals?id=${goal.id}`)}
                    className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/40 transition-colors"
                  >
                    <Target className="h-3.5 w-3.5 text-green-500 shrink-0" />
                    <span className="flex-1 truncate">{goal.title}</span>
                    <StatusBadge status={goal.status} />
                  </button>
                ))}
              </div>
            )}

            {/* Linked Notes */}
            {notes.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium flex items-center gap-1.5">
                  <NotebookPen className="h-3.5 w-3.5" /> Notes
                </h4>
                {notes.map((note) => (
                  <button
                    key={note.id}
                    onClick={() => navigate(`/notes?id=${note.id}`)}
                    className="flex items-center gap-2 w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted/40 transition-colors"
                  >
                    <NotebookPen className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                    <span className="flex-1 truncate">{note.title}</span>
                  </button>
                ))}
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={() => setEditingProject(fresh)}>
                <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDeleteTarget(fresh)}>
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
              </Button>
            </div>
          </div>
        </EntityDetail>

        <EntityDialog
          open={!!editingProject}
          onOpenChange={(open) => !open && setEditingProject(null)}
          entityType="project"
          title="Edit Project"
          defaultValues={editingProject ?? undefined}
          onSubmit={handleEdit}
        />

        <ConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title="Delete Project"
          description={`Are you sure you want to delete "${deleteTarget?.title}"? Linked tasks will not be deleted.`}
          onConfirm={() => {
            if (deleteTarget) {
              remove.mutate(deleteTarget.id)
              notify({ title: 'Project deleted', type: 'success' })
              setSelectedProject(null)
              setDeleteTarget(null)
            }
          }}
        />
      </div>
    )
  }

  /* ─── List / Grid View ─── */

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2">
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as EntityStatus | 'all')}
          >
            <SelectTrigger className="w-[130px] h-8 text-xs">
              <SelectValue placeholder="Filter status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="in-progress">Active</SelectItem>
              <SelectItem value="todo">Planned</SelectItem>
              <SelectItem value="done">Completed</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search projects..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="h-8 text-xs pl-7 w-[180px]"
            />
            {searchQuery && (
              <button onClick={() => setSearchQuery('')} className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <ViewToggle value={viewMode} onChange={handleViewChange} />
          <Button size="sm" className="h-8" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Project
          </Button>
        </div>
      </div>

      {/* Content */}
      {projects.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Create your first project to start organizing your work."
          actionLabel="New Project"
          onAction={() => setDialogOpen(true)}
        />
      ) : viewMode === 'grid' ? (
        /* ── Grid View ── */
        <div className="space-y-6">
          {grouped.map(([status, items]) => (
            <div key={status}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
                {statusLabels[status] ?? status}
                <span className="ml-1.5 text-muted-foreground/50">{items.length}</span>
              </h3>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {items.map((project) => {
                  const progress = getProgress(project.id)
                  const tasks = getLinkedTasks(project.id)
                  const category = getCategory(project)
                  const stack = getStack(project)

                  return (
                    <Card
                      key={project.id}
                      className="cursor-pointer hover:bg-accent/50 transition-colors"
                      onClick={() => setSelectedProject(project)}
                    >
                      <CardHeader className="pb-2">
                        <div className="flex items-start justify-between gap-2">
                          <CardTitle className="text-sm font-medium">{project.title}</CardTitle>
                          <PriorityBadge priority={project.priority} />
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <div className="flex items-center gap-2">
                          <Badge className={`text-[10px] ${categoryColors[category]}`}>{category}</Badge>
                          {getDomain(project) !== 'personal' && (
                            <Badge variant="outline" className="text-[10px]">
                              {domainLabels[getDomain(project)] ?? getDomain(project)}
                            </Badge>
                          )}
                        </div>

                        {project.description && (
                          <p className="text-xs text-muted-foreground line-clamp-2">{project.description}</p>
                        )}

                        {stack.length > 0 && (
                          <div className="flex flex-wrap gap-1">
                            {stack.slice(0, 4).map((s) => (
                              <span key={s} className="text-[10px] bg-secondary px-1.5 py-0.5 rounded">{s}</span>
                            ))}
                            {stack.length > 4 && (
                              <span className="text-[10px] text-muted-foreground">+{stack.length - 4}</span>
                            )}
                          </div>
                        )}

                        <div className="space-y-1">
                          <div className="flex justify-between text-xs">
                            <span className="text-muted-foreground">{tasks.length} tasks</span>
                            <span className="tabular-nums">{progress}%</span>
                          </div>
                          <Progress value={progress} className="h-1.5" />
                        </div>
                      </CardContent>
                    </Card>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      ) : (
        /* ── List View ── */
        <div className="space-y-4">
          {grouped.map(([status, items]) => (
            <div key={status}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                {statusLabels[status] ?? status}
                <span className="ml-1.5 text-muted-foreground/50">{items.length}</span>
              </h3>
              <div className="border rounded-lg divide-y">
                {items.map((project) => {
                  const progress = getProgress(project.id)
                  const tasks = getLinkedTasks(project.id)
                  const category = getCategory(project)
                  const stack = getStack(project)
                  const summary = getSummary(project)

                  return (
                    <div
                      key={project.id}
                      className="flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors cursor-pointer"
                      onClick={() => setSelectedProject(project)}
                    >
                      {/* Category emoji */}
                      <span className="text-lg shrink-0">{categoryEmoji[category]}</span>

                      {/* Main info */}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{project.title}</span>
                          <Badge className={`text-[9px] px-1.5 ${categoryColors[category]}`}>{category}</Badge>
                          {getDomain(project) !== 'personal' && (
                            <Badge variant="outline" className="text-[9px] px-1.5">
                              {domainLabels[getDomain(project)] ?? getDomain(project)}
                            </Badge>
                          )}
                        </div>
                        <div className="flex items-center gap-2 mt-0.5">
                          {summary && <span className="text-xs text-muted-foreground truncate max-w-[300px]">{summary}</span>}
                          {stack.length > 0 && (
                            <span className="text-[10px] text-muted-foreground/50 shrink-0">
                              {stack.slice(0, 3).join(' · ')}{stack.length > 3 ? ` +${stack.length - 3}` : ''}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* Tasks count */}
                      <span className="text-xs text-muted-foreground shrink-0 tabular-nums">
                        {tasks.filter((t) => t.status === 'done').length}/{tasks.length}
                      </span>

                      {/* Progress */}
                      <div className="flex items-center gap-1.5 shrink-0">
                        <Progress value={progress} className="h-1.5 w-16" />
                        <span className="text-[11px] tabular-nums text-muted-foreground w-7 text-right">{progress}%</span>
                      </div>

                      {/* Quick status */}
                      <Select
                        value={project.status}
                        onValueChange={(v) => {
                          handleQuickStatus(project, v as EntityStatus)
                        }}
                      >
                        <SelectTrigger
                          className="h-7 w-[100px] text-[11px] shrink-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="in-progress">Active</SelectItem>
                          <SelectItem value="todo">Planned</SelectItem>
                          <SelectItem value="done">Completed</SelectItem>
                          <SelectItem value="backlog">Backlog</SelectItem>
                          <SelectItem value="archived">Archived</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <ProjectCreateDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreate}
      />
    </div>
  )
}
