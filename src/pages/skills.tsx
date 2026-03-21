import { useState, useMemo, useEffect } from 'react'
import { useSearchParams } from 'react-router'
import {
  Plus,
  Zap,
  Pencil,
  Trash2,
  ChevronLeft,
  Search,
  X,
  AlertTriangle,
  FolderKanban,
} from 'lucide-react'
import { ViewToggle, getStoredView, storeView, type ViewMode } from '@/components/view-toggle'
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
import { Badge } from '@/components/ui/badge'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EntityDetail } from '@/core/components/entity-detail'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import type { Entity, EntityStatus } from '@/core/types'

/* ─── Mastery config ─── */

const MASTERY_LEVELS = ['novice', 'competent', 'proficient', 'expert'] as const
type MasteryLevel = (typeof MASTERY_LEVELS)[number]

const masteryColors: Record<MasteryLevel, string> = {
  novice: 'bg-gray-500/10 text-gray-600',
  competent: 'bg-blue-500/10 text-blue-600',
  proficient: 'bg-amber-500/10 text-amber-600',
  expert: 'bg-emerald-500/10 text-emerald-600',
}

const masteryLabels: Record<MasteryLevel, string> = {
  novice: 'Novice',
  competent: 'Competent',
  proficient: 'Proficient',
  expert: 'Expert',
}

/* ─── Metadata helpers ─── */

function getMastery(skill: Entity): MasteryLevel {
  const m = skill.metadata?.mastery as string | undefined
  return MASTERY_LEVELS.includes(m as MasteryLevel) ? (m as MasteryLevel) : 'novice'
}

function getDomain(skill: Entity): string {
  return (skill.metadata?.domain as string) ?? ''
}

function getLastPracticed(skill: Entity): string | null {
  return (skill.metadata?.lastPracticed as string) ?? null
}

function getProjectIds(skill: Entity): string[] {
  const ids = skill.metadata?.projectIds
  return Array.isArray(ids) ? (ids as string[]) : []
}

function getNotes(skill: Entity): string {
  return (skill.metadata?.notes as string) ?? ''
}

function isRusty(skill: Entity): boolean {
  const last = getLastPracticed(skill)
  if (!last) return true
  const diff = Date.now() - new Date(last).getTime()
  return diff > 30 * 24 * 60 * 60 * 1000
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now()
  const then = new Date(dateStr).getTime()
  const diffMs = now - then
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays < 1) return 'today'
  if (diffDays === 1) return '1 day ago'
  if (diffDays < 7) return `${diffDays} days ago`
  const diffWeeks = Math.floor(diffDays / 7)
  if (diffWeeks === 1) return '1 week ago'
  if (diffWeeks < 4) return `${diffWeeks} weeks ago`
  const diffMonths = Math.floor(diffDays / 30)
  if (diffMonths === 1) return '1 month ago'
  return `${diffMonths} months ago`
}

/* ─── Create / Edit Dialog ─── */

interface SkillFormValues {
  title: string
  description: string
  mastery: MasteryLevel
  domain: string
  notes: string
}

function SkillDialog({
  open,
  onOpenChange,
  title,
  defaultValues,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  defaultValues?: Partial<Entity>
  onSubmit: (values: SkillFormValues) => void
}) {
  const [form, setForm] = useState<SkillFormValues>({
    title: '',
    description: '',
    mastery: 'novice',
    domain: '',
    notes: '',
  })

  useEffect(() => {
    if (open && defaultValues) {
      setForm({
        title: defaultValues.title ?? '',
        description: defaultValues.description ?? '',
        mastery: (defaultValues.metadata?.mastery as MasteryLevel) ?? 'novice',
        domain: (defaultValues.metadata?.domain as string) ?? '',
        notes: (defaultValues.metadata?.notes as string) ?? '',
      })
    } else if (open) {
      setForm({ title: '', description: '', mastery: 'novice', domain: '', notes: '' })
    }
  }, [open, defaultValues])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.title.trim()) return
    onSubmit(form)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="skill-title">Title</Label>
            <Input
              id="skill-title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              placeholder="Skill name"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-description">Description</Label>
            <Textarea
              id="skill-description"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
              placeholder="Brief description"
              rows={2}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-mastery">Mastery Level</Label>
            <Select
              value={form.mastery}
              onValueChange={(v) => setForm((f) => ({ ...f, mastery: v as MasteryLevel }))}
            >
              <SelectTrigger id="skill-mastery">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {MASTERY_LEVELS.map((level) => (
                  <SelectItem key={level} value={level}>
                    {masteryLabels[level]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-domain">Domain</Label>
            <Input
              id="skill-domain"
              value={form.domain}
              onChange={(e) => setForm((f) => ({ ...f, domain: e.target.value }))}
              placeholder="e.g., engineering, finance, health"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="skill-notes">Notes</Label>
            <Textarea
              id="skill-notes"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
              placeholder="Additional notes"
              rows={3}
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit">Save</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/* ─── Mastery Badge ─── */

function MasteryBadge({ mastery }: { mastery: MasteryLevel }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${masteryColors[mastery]}`}
    >
      {masteryLabels[mastery]}
    </span>
  )
}

/* ─── Main Page ─── */

export function SkillsPage() {
  const { items: allSkills, isLoading, create, update, remove } = useEntities('skill')
  const currentUser = useAuthStore((s) => s.currentUser)
  const [searchParams, setSearchParams] = useSearchParams()

  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'all'>('all')
  const [masteryFilter, setMasteryFilter] = useState<MasteryLevel | 'all'>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingSkill, setEditingSkill] = useState<Entity | null>(null)
  const [selectedSkill, setSelectedSkill] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)
  const [viewMode, setViewMode] = useState<ViewMode>(() => getStoredView('skills'))

  const handleViewChange = (mode: ViewMode) => {
    setViewMode(mode)
    storeView('skills', mode)
  }

  // Auto-select skill from URL param ?id=skill-1
  useEffect(() => {
    const skillId = searchParams.get('id')
    if (skillId && allSkills.length > 0 && !selectedSkill) {
      const skill = allSkills.find((s) => s.id === skillId)
      if (skill) {
        setSelectedSkill(skill)
        searchParams.delete('id')
        setSearchParams(searchParams, { replace: true })
      }
    }
  }, [searchParams, allSkills, selectedSkill, setSearchParams])

  const skills = useMemo(() => {
    let filtered = allSkills
    if (statusFilter !== 'all') {
      filtered = filtered.filter((s) => s.status === statusFilter)
    }
    if (masteryFilter !== 'all') {
      filtered = filtered.filter((s) => getMastery(s) === masteryFilter)
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase()
      filtered = filtered.filter(
        (s) =>
          s.title.toLowerCase().includes(q) ||
          getDomain(s).toLowerCase().includes(q),
      )
    }
    return filtered
  }, [allSkills, statusFilter, masteryFilter, searchQuery])

  const rustySkills = useMemo(() => skills.filter(isRusty), [skills])
  const nonRustySkills = useMemo(
    () => skills.filter((s) => !isRusty(s)),
    [skills],
  )

  const handleCreate = (values: SkillFormValues) => {
    create.mutate({
      id: crypto.randomUUID(),
      type: 'skill',
      title: values.title,
      description: values.description || undefined,
      status: 'todo',
      priority: 'medium',
      tags: [],
      metadata: {
        mastery: values.mastery,
        domain: values.domain,
        lastPracticed: new Date().toISOString(),
        projectIds: [],
        notes: values.notes,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Skill created', type: 'success' })
  }

  const handleEdit = (values: SkillFormValues) => {
    if (!editingSkill) return
    update.mutate({
      id: editingSkill.id,
      updates: {
        title: values.title,
        description: values.description || undefined,
        metadata: {
          ...editingSkill.metadata,
          mastery: values.mastery,
          domain: values.domain,
          notes: values.notes,
        },
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Skill updated', type: 'success' })
    setEditingSkill(null)
  }

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  // Detail view for a selected skill
  if (selectedSkill) {
    const fresh = allSkills.find((s) => s.id === selectedSkill.id) ?? selectedSkill
    const mastery = getMastery(fresh)
    const domain = getDomain(fresh)
    const lastPracticed = getLastPracticed(fresh)
    const projectIds = getProjectIds(fresh)
    const notes = getNotes(fresh)

    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setSelectedSkill(null)}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Back to skills
        </Button>

        <EntityDetail entity={fresh} showComments currentUserId={currentUser?.id}>
          <div className="space-y-4">
            {/* Mastery editor */}
            <div className="space-y-1">
              <span className="text-sm text-muted-foreground">Mastery Level</span>
              <Select
                value={mastery}
                onValueChange={(v) =>
                  update.mutate({
                    id: fresh.id,
                    updates: {
                      metadata: { ...fresh.metadata, mastery: v },
                      updatedAt: new Date().toISOString(),
                    },
                  })
                }
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {MASTERY_LEVELS.map((level) => (
                    <SelectItem key={level} value={level}>
                      {masteryLabels[level]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Domain editor */}
            <div className="space-y-1">
              <span className="text-sm text-muted-foreground">Domain</span>
              <Input
                value={domain}
                onChange={(e) =>
                  update.mutate({
                    id: fresh.id,
                    updates: {
                      metadata: { ...fresh.metadata, domain: e.target.value },
                      updatedAt: new Date().toISOString(),
                    },
                  })
                }
                placeholder="e.g., engineering, finance"
                className="w-[240px]"
              />
            </div>

            {/* Last practiced */}
            {lastPracticed && (
              <div className="space-y-1">
                <span className="text-sm text-muted-foreground">Last Practiced</span>
                <p className="text-sm">
                  {formatRelativeTime(lastPracticed)}
                  {isRusty(fresh) && (
                    <span className="inline-flex items-center ml-2 text-amber-600">
                      <AlertTriangle className="h-3.5 w-3.5 mr-1" />
                      Rusty
                    </span>
                  )}
                </p>
              </div>
            )}

            {/* Linked projects */}
            {projectIds.length > 0 && (
              <div className="space-y-1">
                <span className="text-sm text-muted-foreground">Linked Projects</span>
                <p className="text-sm flex items-center gap-1">
                  <FolderKanban className="h-3.5 w-3.5" />
                  {projectIds.length} project{projectIds.length !== 1 ? 's' : ''}
                </p>
              </div>
            )}

            {/* Notes */}
            {notes && (
              <div className="space-y-1">
                <span className="text-sm text-muted-foreground">Notes</span>
                <p className="text-sm whitespace-pre-wrap">{notes}</p>
              </div>
            )}

            {/* Actions */}
            <div className="flex gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={() => setEditingSkill(fresh)}>
                <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDeleteTarget(fresh)}>
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
              </Button>
            </div>
          </div>
        </EntityDetail>

        {/* Edit dialog */}
        <SkillDialog
          open={!!editingSkill}
          onOpenChange={(open) => !open && setEditingSkill(null)}
          title="Edit Skill"
          defaultValues={editingSkill ?? undefined}
          onSubmit={handleEdit}
        />

        <ConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title="Delete Skill"
          description={`Are you sure you want to delete "${deleteTarget?.title}"?`}
          onConfirm={() => {
            if (deleteTarget) {
              remove.mutate(deleteTarget.id)
              notify({ title: 'Skill deleted', type: 'success' })
              setSelectedSkill(null)
              setDeleteTarget(null)
            }
          }}
        />
      </div>
    )
  }

  // Skill card (grid)
  const renderSkillCard = (skill: Entity) => {
    const mastery = getMastery(skill)
    const domain = getDomain(skill)
    const lastPracticed = getLastPracticed(skill)
    const projectIds = getProjectIds(skill)
    const rusty = isRusty(skill)

    return (
      <Card
        key={skill.id}
        className="cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setSelectedSkill(skill)}
      >
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-2">
            <CardTitle className="text-sm font-medium">{skill.title}</CardTitle>
            <MasteryBadge mastery={mastery} />
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {domain && (
            <Badge variant="secondary" className="text-xs">
              {domain}
            </Badge>
          )}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            {lastPracticed && <span>{formatRelativeTime(lastPracticed)}</span>}
            {projectIds.length > 0 && (
              <span className="flex items-center gap-1">
                <FolderKanban className="h-3 w-3" />
                {projectIds.length}
              </span>
            )}
          </div>
          {rusty && (
            <span className="inline-flex items-center text-xs text-amber-600">
              <AlertTriangle className="h-3 w-3 mr-1" />
              Rusty
            </span>
          )}
        </CardContent>
      </Card>
    )
  }

  // Skill row (list)
  const renderSkillRow = (skill: Entity) => {
    const mastery = getMastery(skill)
    const domain = getDomain(skill)
    const lastPracticed = getLastPracticed(skill)
    const projectIds = getProjectIds(skill)
    const rusty = isRusty(skill)

    return (
      <div
        key={skill.id}
        className="flex items-center gap-4 px-4 py-3 cursor-pointer hover:bg-accent/50 transition-colors"
        onClick={() => setSelectedSkill(skill)}
      >
        <div className="flex-1 min-w-0">
          <span className="text-sm font-medium">{skill.title}</span>
        </div>
        <MasteryBadge mastery={mastery} />
        {domain && (
          <Badge variant="secondary" className="text-xs shrink-0">
            {domain}
          </Badge>
        )}
        {lastPracticed && (
          <span className="text-xs text-muted-foreground whitespace-nowrap">
            {formatRelativeTime(lastPracticed)}
          </span>
        )}
        {projectIds.length > 0 && (
          <span className="text-xs text-muted-foreground flex items-center gap-1 shrink-0">
            <FolderKanban className="h-3 w-3" />
            {projectIds.length}
          </span>
        )}
        {rusty && (
          <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0" />
        )}
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search skills..."
              className="pl-8 w-[200px]"
            />
            {searchQuery && (
              <button
                type="button"
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                onClick={() => setSearchQuery('')}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Status filter */}
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as EntityStatus | 'all')}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Filter status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Status</SelectItem>
              <SelectItem value="todo">To Do</SelectItem>
              <SelectItem value="in-progress">In Progress</SelectItem>
              <SelectItem value="done">Done</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>

          {/* Mastery filter */}
          <Select
            value={masteryFilter}
            onValueChange={(v) => setMasteryFilter(v as MasteryLevel | 'all')}
          >
            <SelectTrigger className="w-[150px]">
              <SelectValue placeholder="Filter mastery" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Mastery</SelectItem>
              {MASTERY_LEVELS.map((level) => (
                <SelectItem key={level} value={level}>
                  {masteryLabels[level]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-2">
          <ViewToggle value={viewMode} onChange={handleViewChange} />
          <Button size="sm" onClick={() => setDialogOpen(true)}>
            <Plus className="h-4 w-4 mr-1" /> New Skill
          </Button>
        </div>
      </div>

      {/* Rusty skills section */}
      {rustySkills.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-medium flex items-center gap-1.5 text-amber-600">
            <AlertTriangle className="h-4 w-4" />
            Rusty Skills ({rustySkills.length})
          </h3>
          {viewMode === 'grid' ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {rustySkills.map(renderSkillCard)}
            </div>
          ) : (
            <div className="border rounded-lg divide-y">
              {rustySkills.map(renderSkillRow)}
            </div>
          )}
        </div>
      )}

      {/* Main skills list */}
      {skills.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No skills yet"
          description="Create your first skill to start tracking your knowledge."
          actionLabel="New Skill"
          onAction={() => setDialogOpen(true)}
        />
      ) : nonRustySkills.length > 0 ? (
        <>
          {rustySkills.length > 0 && (
            <h3 className="text-sm font-medium text-muted-foreground">
              Active Skills ({nonRustySkills.length})
            </h3>
          )}
          {viewMode === 'grid' ? (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {nonRustySkills.map(renderSkillCard)}
            </div>
          ) : (
            <div className="border rounded-lg divide-y">
              {nonRustySkills.map(renderSkillRow)}
            </div>
          )}
        </>
      ) : null}

      {/* Create dialog */}
      <SkillDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        title="New Skill"
        onSubmit={handleCreate}
      />
    </div>
  )
}
