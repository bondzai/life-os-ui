import { useState, useMemo } from 'react'
import { Plus, Brain, Pencil, Trash2, ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
import { EntityDialog } from '@/core/components/entity-dialog'
import { EntityDetail } from '@/core/components/entity-detail'
import { StatusBadge } from '@/core/components/status-badge'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import { PracticeLog } from './skills/practice-log'
import type { Entity, EntityStatus } from '@/core/types'

const LEVELS = ['beginner', 'intermediate', 'advanced', 'expert'] as const

const levelColors: Record<string, string> = {
  beginner: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  intermediate: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  advanced: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
  expert: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300',
}

export function SkillsPage() {
  const { items: skills, isLoading, create, update, remove } = useEntities('skill')
  const { items: allEntities } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)

  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'all'>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingSkill, setEditingSkill] = useState<Entity | null>(null)
  const [selectedSkill, setSelectedSkill] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)

  const filteredSkills = useMemo(() => {
    if (statusFilter === 'all') return skills
    return skills.filter((s) => s.status === statusFilter)
  }, [skills, statusFilter])

  const getRelatedResources = (skill: Entity) =>
    allEntities.filter(
      (e) =>
        (e.type === 'book' || e.type === 'course') &&
        e.tags.some((tag) => skill.tags.includes(tag)),
    )

  const getLevel = (skill: Entity): string =>
    typeof skill.metadata.level === 'string' ? skill.metadata.level : 'beginner'

  const handleCreate = (values: Record<string, unknown>) => {
    const tags =
      typeof values.tags === 'string'
        ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : []
    create.mutate({
      id: crypto.randomUUID(),
      type: 'skill',
      title: values.title as string,
      description: (values.description as string) || undefined,
      status: (values.status as EntityStatus) || 'active',
      priority: (values.priority as Entity['priority']) || 'medium',
      tags,
      metadata: { level: 'beginner' },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Skill created', type: 'success' })
  }

  const handleEdit = (values: Record<string, unknown>) => {
    if (!editingSkill) return
    const tags =
      typeof values.tags === 'string'
        ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : []
    update.mutate({
      id: editingSkill.id,
      updates: {
        title: values.title as string,
        description: (values.description as string) || undefined,
        status: values.status as EntityStatus,
        priority: values.priority as Entity['priority'],
        tags,
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Skill updated', type: 'success' })
    setEditingSkill(null)
  }

  const handleLevelChange = (skill: Entity, level: string) => {
    update.mutate({
      id: skill.id,
      updates: {
        metadata: { ...skill.metadata, level },
        updatedAt: new Date().toISOString(),
      },
    })
  }

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  // Detail view
  if (selectedSkill) {
    const fresh = skills.find((s) => s.id === selectedSkill.id) ?? selectedSkill
    const level = getLevel(fresh)
    const related = getRelatedResources(fresh)

    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setSelectedSkill(null)}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Back to skills
        </Button>

        <EntityDetail entity={fresh} showComments currentUserId={currentUser?.id}>
          <div className="space-y-4">
            {/* Level selector */}
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">Level</label>
              <Select value={level} onValueChange={(v) => handleLevelChange(fresh, v)}>
                <SelectTrigger className="w-[180px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {LEVELS.map((l) => (
                    <SelectItem key={l} value={l} className="capitalize">
                      {l}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {/* Practice log */}
            <PracticeLog skillId={fresh.id} />

            {/* Related books/courses */}
            {related.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Related Resources</h4>
                {related.map((r) => (
                  <Card key={r.id}>
                    <CardContent className="flex items-center justify-between py-3">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs capitalize">
                          {r.type}
                        </Badge>
                        <span className="text-sm">{r.title}</span>
                      </div>
                      <StatusBadge status={r.status} />
                    </CardContent>
                  </Card>
                ))}
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

        <EntityDialog
          open={!!editingSkill}
          onOpenChange={(open) => !open && setEditingSkill(null)}
          entityType="skill"
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

  // Grid view
  return (
    <div className="space-y-4">
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
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> New Skill
        </Button>
      </div>

      {/* Skill cards */}
      {filteredSkills.length === 0 ? (
        <EmptyState
          icon={Brain}
          title="No skills yet"
          description="Add a skill to start tracking your growth."
          actionLabel="New Skill"
          onAction={() => setDialogOpen(true)}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {filteredSkills.map((skill) => {
            const level = getLevel(skill)
            return (
              <Card
                key={skill.id}
                className="cursor-pointer hover:bg-accent/50 transition-colors"
                onClick={() => setSelectedSkill(skill)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-sm font-medium">
                      {skill.title}
                    </CardTitle>
                    <div className="flex gap-1">
                      <Badge
                        className={`text-xs capitalize ${levelColors[level] ?? ''}`}
                        variant="secondary"
                      >
                        {level}
                      </Badge>
                      <StatusBadge status={skill.status} />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {skill.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {skill.description}
                    </p>
                  )}
                  {skill.tags.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {skill.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-xs bg-secondary px-1.5 py-0.5 rounded"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      {/* Create dialog */}
      <EntityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entityType="skill"
        title="New Skill"
        onSubmit={handleCreate}
      />
    </div>
  )
}
