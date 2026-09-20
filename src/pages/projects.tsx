/**
 * Projects — the things you are actually building.
 *
 * This existed once (`a3e9f49`, Mar 21) and was folded into Goals by `fd2948e` a week later, on
 * the grounds that two hierarchies were one too many. It is back because a Shorts channel and a
 * freelance contract are not goals in any useful sense: a goal is an outcome you want, a project
 * is a body of work with a repo, a client, or a publishing schedule attached.
 *
 * **No migration, no new table.** A project is an ordinary entity with `type: 'project'`, which
 * the API has always accepted. Everything specific lives in `metadata`, unset on the projects that
 * do not need it — which is the point of one model with optional extras rather than two models.
 *
 * **Tasks belong to a project through `metadata.projectId`,** the convention the codebase already
 * reads: `use-velocity.ts`, `detect-stale-projects.ts`, `detect-velocity.ts`, the morning brief
 * and the AI context builders all look for it. Setting that one field is what makes the velocity
 * panel and the stale-project widget work here without a line of new code.
 */

import { useState, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import { Plus, FolderKanban, Pencil, Trash2, ChevronLeft, ExternalLink } from 'lucide-react'
import { ViewToggle, getStoredView, storeView, type ViewMode } from '@/components/view-toggle'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Progress } from '@/components/ui/progress'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDialog } from '@/core/components/entity-dialog'
import { EntityDetail } from '@/core/components/entity-detail'
import { PriorityBadge } from '@/core/components/priority-badge'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { SavedFilterBar } from '@/core/components/saved-filter-bar'
import { VelocityPanel } from '@/pages/goals/velocity-panel'
import { AIAction } from '@/components/ai-action'
import { notify } from '@/lib/notify'
import type { Entity, EntityStatus } from '@/core/types'
import { projectOf, projectStatusLabel, PROJECT_STATUSES } from './projects/project-meta'

export function ProjectsPage() {
  // Both scoped, so each asks the server for its own type instead of pulling the whole table.
  const { items: projects, isLoading, create, update, remove } = useEntities('project')
  const { items: tasks } = useEntities('task')

  const currentUser = useAuthStore((s) => s.currentUser)
  const [searchParams, setSearchParams] = useSearchParams()

  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'all'>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>(() => getStoredView('projects'))

  const handleViewChange = (mode: ViewMode) => {
    setViewMode(mode)
    storeView('projects', mode)
  }

  /**
   * Which project is open lives in the URL, not in state.
   *
   * The Goals page copies `?id=` into state inside an effect, which needs the list to have loaded
   * first and leaves the back button doing nothing. Deriving it means no effect, no second copy of
   * the truth, and a detail view you can link someone to.
   */
  const selectedId = searchParams.get('id')
  const selected = selectedId ? (projects.find((p) => p.id === selectedId) ?? null) : null

  const openProject = (id: string) => setSearchParams({ id })
  const closeProject = () => {
    searchParams.delete('id')
    setSearchParams(searchParams, { replace: true })
  }

  /**
   * Tasks per project, in one pass.
   *
   * A map rather than a `.filter()` inside the render: at a few dozen projects and a few hundred
   * tasks the per-card scan is the difference between one pass and a few thousand.
   */
  const taskCounts = useMemo(() => {
    const counts = new Map<string, { total: number; done: number }>()
    for (const task of tasks) {
      if (task.status === 'archived') continue
      const projectId = task.metadata?.projectId
      if (typeof projectId !== 'string') continue
      const row = counts.get(projectId) ?? { total: 0, done: 0 }
      row.total += 1
      if (task.status === 'done') row.done += 1
      counts.set(projectId, row)
    }
    return counts
  }, [tasks])

  const visible = useMemo(
    () => (statusFilter === 'all' ? projects : projects.filter((p) => p.status === statusFilter)),
    [projects, statusFilter],
  )

  const handleCreate = (values: Record<string, unknown>) => {
    const tags =
      typeof values.tags === 'string'
        ? values.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : []
    create.mutate({
      id: crypto.randomUUID(),
      type: 'project',
      title: values.title as string,
      description: (values.description as string) || undefined,
      status: (values.status as EntityStatus) || 'todo',
      priority: (values.priority as Entity['priority']) || 'medium',
      tags,
      metadata: {},
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      dueDate: (values.dueDate as string) || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Project created', type: 'success' })
  }

  const handleEdit = (values: Record<string, unknown>) => {
    if (!editing) return
    const tags =
      typeof values.tags === 'string'
        ? values.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : []
    update.mutate({
      id: editing.id,
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
    setEditing(null)
  }

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  if (selected) {
    const fresh = selected
    const counts = taskCounts.get(fresh.id) ?? { total: 0, done: 0 }
    const projectTasks = tasks.filter(
      (t) => t.metadata?.projectId === fresh.id && t.status !== 'archived',
    )

    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={closeProject}>
          <ChevronLeft className="mr-1 h-4 w-4" /> All projects
        </Button>

        <EntityDetail entity={fresh} showComments currentUserId={currentUser?.id}>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="outline">{projectStatusLabel(fresh.status)}</Badge>
            <PriorityBadge priority={fresh.priority} />
            {counts.total > 0 && (
              <span className="text-xs text-muted-foreground">
                {counts.done} of {counts.total} tasks done
              </span>
            )}
          </div>

          <ProjectFacts
            project={fresh}
            onSave={(metadata) => {
              update.mutate({
                id: fresh.id,
                // Metadata is replaced wholesale by the API, never merged — so spread the current
                // value or everything else on it is silently dropped.
                updates: { metadata: { ...fresh.metadata, ...metadata }, updatedAt: new Date().toISOString() },
              })
              notify({ title: 'Project details saved', type: 'success' })
            }}
          />

          <VelocityPanel entityId={fresh.id} entityType="project" dueDate={fresh.dueDate} />

          <div className="space-y-2">
            <h3 className="text-sm font-medium">Tasks</h3>
            {projectTasks.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No tasks yet. Assign one from a task's detail panel to see progress here.
              </p>
            ) : (
              <div className="divide-y rounded-lg border">
                {projectTasks.map((task) => (
                  <div key={task.id} className="flex items-center gap-3 px-3 py-2">
                    <span className="flex-1 truncate text-sm">{task.title}</span>
                    <Badge variant="outline" className="shrink-0 text-xs">
                      {task.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </div>

          <AIAction tool="analyze-risk" entityId={fresh.id} />

          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEditing(fresh)}>
              <Pencil className="mr-1 h-4 w-4" /> Edit
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDeleteTarget(fresh)}>
              <Trash2 className="mr-1 h-4 w-4" /> Delete
            </Button>
          </div>
        </EntityDetail>

        {editing && (
          <EntityDialog
            open
            onOpenChange={(open) => !open && setEditing(null)}
            entityType="project"
            title="Edit Project"
            defaultValues={editing}
            onSubmit={handleEdit}
          />
        )}
        <DeleteProjectDialog
          target={deleteTarget}
          taskCount={taskCounts.get(deleteTarget?.id ?? '')?.total ?? 0}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={(id) => {
            remove.mutate(id)
            setDeleteTarget(null)
            closeProject()
            notify({ title: 'Project deleted', type: 'success' })
          }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Select
          value={statusFilter}
          onValueChange={(v) => setStatusFilter(v as EntityStatus | 'all')}
        >
          <SelectTrigger className="w-[150px]">
            <SelectValue placeholder="Filter status" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All</SelectItem>
            {PROJECT_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {projectStatusLabel(status)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <ViewToggle value={viewMode} onChange={handleViewChange} />
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="mr-1 h-4 w-4" /> New Project
          </Button>
        </div>
      </div>

      <SavedFilterBar
        moduleKey="projects"
        currentCriteria={{ status: statusFilter }}
        onApply={(c) => setStatusFilter((c.status as EntityStatus | 'all') || 'all')}
      />

      {visible.length === 0 ? (
        <EmptyState
          icon={FolderKanban}
          title={projects.length === 0 ? 'No projects yet' : 'No projects match this filter'}
          description={
            projects.length === 0
              ? 'A project is a body of work — a channel, a product, a client contract.'
              : 'Try a different status.'
          }
          actionLabel={projects.length === 0 ? 'New Project' : undefined}
          onAction={projects.length === 0 ? () => setDialogOpen(true) : undefined}
        />
      ) : viewMode === 'grid' ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              counts={taskCounts.get(project.id)}
              onOpen={() => openProject(project.id)}
            />
          ))}
        </div>
      ) : (
        <div className="divide-y rounded-lg border">
          {visible.map((project) => {
            const counts = taskCounts.get(project.id)
            return (
              <div
                key={project.id}
                className="flex cursor-pointer items-center gap-4 px-4 py-3 transition-colors hover:bg-accent/50"
                onClick={() => openProject(project.id)}
              >
                <div className="min-w-0 flex-1">
                  <span className="text-sm font-medium">{project.title}</span>
                  {project.description && (
                    <p className="truncate text-xs text-muted-foreground">{project.description}</p>
                  )}
                </div>
                {counts && (
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {counts.done}/{counts.total} tasks
                  </span>
                )}
                <div className="flex shrink-0 items-center gap-1">
                  <PriorityBadge priority={project.priority} />
                  <Badge variant="outline">{projectStatusLabel(project.status)}</Badge>
                </div>
              </div>
            )
          })}
        </div>
      )}

      <EntityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entityType="project"
        title="New Project"
        onSubmit={handleCreate}
      />
    </div>
  )
}

function ProjectCard({
  project,
  counts,
  onOpen,
}: {
  project: Entity
  counts?: { total: number; done: number }
  onOpen: () => void
}) {
  const facts = projectOf(project)
  const progress = counts && counts.total > 0 ? Math.round((counts.done / counts.total) * 100) : null

  return (
    <Card className="cursor-pointer transition-colors hover:bg-accent/50" onClick={onOpen}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium">{project.title}</CardTitle>
          <div className="flex gap-1">
            <PriorityBadge priority={project.priority} />
            <Badge variant="outline">{projectStatusLabel(project.status)}</Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {project.description && (
          <p className="line-clamp-2 text-xs text-muted-foreground">{project.description}</p>
        )}

        {/* Derived from tasks, not stored: a number you have to remember to update is a number
            that lies. No tasks means no bar, rather than a confident 0%. */}
        {progress !== null && (
          <div className="space-y-1">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">
                {counts!.done} of {counts!.total} tasks
              </span>
              <span className="text-muted-foreground">{progress}%</span>
            </div>
            <Progress value={progress} className="h-2" />
          </div>
        )}

        {facts.client && (
          <p className="text-xs text-muted-foreground">Client: {facts.client}</p>
        )}
        {facts.stack.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {facts.stack.map((item) => (
              <span key={item} className="rounded bg-secondary px-1.5 py-0.5 text-xs">
                {item}
              </span>
            ))}
          </div>
        )}
        {project.dueDate && (
          <p className="text-xs text-muted-foreground">
            Due: {new Date(project.dueDate).toLocaleDateString()}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

/**
 * The optional half of the model, edited in place.
 *
 * Not in the create dialog: `EntityForm` renders `children` but does not register them with its
 * resolver, so a field added there never reaches `onSubmit`. Editing metadata after the fact is
 * the pattern the Goals page already uses for its progress slider.
 */
function ProjectFacts({
  project,
  onSave,
}: {
  project: Entity
  onSave: (metadata: Record<string, unknown>) => void
}) {
  const facts = projectOf(project)
  const [client, setClient] = useState(facts.client ?? '')
  const [repoUrl, setRepoUrl] = useState(facts.repoUrl ?? '')
  const [stack, setStack] = useState(facts.stack.join(', '))

  const dirty =
    client !== (facts.client ?? '') ||
    repoUrl !== (facts.repoUrl ?? '') ||
    stack !== facts.stack.join(', ')

  return (
    <div className="space-y-3 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Details</h3>
        {facts.repoUrl && (
          <a
            href={facts.repoUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            <ExternalLink className="h-3.5 w-3.5" aria-hidden="true" /> Open repo
          </a>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <Label htmlFor="project-client" className="text-xs">
            Client
          </Label>
          <Input
            id="project-client"
            value={client}
            onChange={(e) => setClient(e.target.value)}
            placeholder="Leave empty for your own work"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="project-repo" className="text-xs">
            Repo or link
          </Label>
          <Input
            id="project-repo"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://…"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="project-stack" className="text-xs">
            Stack
          </Label>
          <Input
            id="project-stack"
            value={stack}
            onChange={(e) => setStack(e.target.value)}
            placeholder="rust, react"
          />
        </div>
      </div>

      {dirty && (
        <Button
          size="sm"
          onClick={() =>
            onSave({
              client: client.trim() || undefined,
              repoUrl: repoUrl.trim() || undefined,
              stack: stack.split(',').map((s) => s.trim()).filter(Boolean),
            })
          }
        >
          Save details
        </Button>
      )}
    </div>
  )
}

/**
 * Deleting a project says what happens to its tasks.
 *
 * The API hard-deletes with no cascade, so the tasks survive with a `projectId` pointing at
 * nothing. That is the safer default — losing a project should not lose the work — but it is only
 * safe if the person clicking knows it.
 */
function DeleteProjectDialog({
  target,
  taskCount,
  onCancel,
  onConfirm,
}: {
  target: Entity | null
  taskCount: number
  onCancel: () => void
  onConfirm: (id: string) => void
}) {
  if (!target) return null
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => !open && onCancel()}
      title={`Delete "${target.title}"?`}
      description={
        taskCount > 0
          ? `${taskCount} task${taskCount === 1 ? '' : 's'} will stay where they are, no longer assigned to a project.`
          : 'This cannot be undone.'
      }
      onConfirm={() => onConfirm(target.id)}
    />
  )
}
