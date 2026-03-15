import { useState, useMemo } from 'react'
import { Plus, GraduationCap, BookOpen, Brain, Pencil, Trash2, Star, ChevronLeft } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
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
import { ReadingChallenge } from './reading/reading-challenge'
import { PracticeLog } from './skills/practice-log'
import type { Entity, EntityStatus, EntityType } from '@/core/types'

type TabType = 'books' | 'courses' | 'skills'

const LEVELS = ['beginner', 'intermediate', 'advanced', 'expert'] as const
const levelColors: Record<string, string> = {
  beginner: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  intermediate: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  advanced: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
  expert: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-300',
}

export function LearningPage() {
  const { items: allEntities, isLoading, create, update, remove } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)

  const [activeTab, setActiveTab] = useState<TabType>('books')
  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'all'>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingItem, setEditingItem] = useState<Entity | null>(null)
  const [selectedSkill, setSelectedSkill] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)

  const entityType: EntityType = activeTab === 'books' ? 'book' : activeTab === 'courses' ? 'course' : 'skill'

  const items = useMemo(() => {
    let filtered = allEntities.filter((e) => {
      if (activeTab === 'books') return e.type === 'book'
      if (activeTab === 'courses') return e.type === 'course'
      return e.type === 'skill'
    })
    if (statusFilter !== 'all') {
      filtered = filtered.filter((e) => e.status === statusFilter)
    }
    return filtered
  }, [allEntities, activeTab, statusFilter])

  const handleCreate = (values: Record<string, unknown>) => {
    const tags = typeof values.tags === 'string'
      ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : []
    create.mutate({
      id: crypto.randomUUID(),
      type: entityType,
      title: values.title as string,
      description: (values.description as string) || undefined,
      status: (values.status as EntityStatus) || 'active',
      priority: (values.priority as Entity['priority']) || 'medium',
      tags,
      metadata: activeTab === 'skills' ? { level: 'beginner' } : {},
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: `${entityType.charAt(0).toUpperCase() + entityType.slice(1)} created`, type: 'success' })
  }

  const handleEdit = (values: Record<string, unknown>) => {
    if (!editingItem) return
    const tags = typeof values.tags === 'string'
      ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
      : []
    update.mutate({
      id: editingItem.id,
      updates: {
        title: values.title as string,
        description: (values.description as string) || undefined,
        status: values.status as EntityStatus,
        priority: values.priority as Entity['priority'],
        tags,
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Updated', type: 'success' })
    setEditingItem(null)
  }

  const tabLabel: Record<TabType, string> = { books: 'Books', courses: 'Courses', skills: 'Skills' }

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  // Skill detail view
  if (selectedSkill) {
    const fresh = allEntities.find((s) => s.id === selectedSkill.id) ?? selectedSkill
    const level = typeof fresh.metadata.level === 'string' ? fresh.metadata.level : 'beginner'
    const related = allEntities.filter(
      (e) => (e.type === 'book' || e.type === 'course') && e.tags.some((tag) => fresh.tags.includes(tag)),
    )

    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setSelectedSkill(null)}>
          <ChevronLeft className="h-4 w-4 mr-1" /> Back
        </Button>

        <EntityDetail entity={fresh} showComments currentUserId={currentUser?.id}>
          <div className="space-y-4">
            <div className="space-y-1">
              <label className="text-sm text-muted-foreground">Level</label>
              <Select value={level} onValueChange={(v) => {
                update.mutate({ id: fresh.id, updates: { metadata: { ...fresh.metadata, level: v }, updatedAt: new Date().toISOString() } })
              }}>
                <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {LEVELS.map((l) => <SelectItem key={l} value={l} className="capitalize">{l}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>

            <PracticeLog skillId={fresh.id} />

            {related.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">Related Resources</h4>
                {related.map((r) => (
                  <Card key={r.id}>
                    <CardContent className="flex items-center justify-between py-3">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="text-xs capitalize">{r.type}</Badge>
                        <span className="text-sm">{r.title}</span>
                      </div>
                      <StatusBadge status={r.status} />
                    </CardContent>
                  </Card>
                ))}
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <Button size="sm" variant="outline" onClick={() => setEditingItem(fresh)}>
                <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
              </Button>
              <Button size="sm" variant="outline" onClick={() => setDeleteTarget(fresh)}>
                <Trash2 className="h-3.5 w-3.5 mr-1" /> Delete
              </Button>
            </div>
          </div>
        </EntityDetail>

        <EntityDialog
          open={!!editingItem}
          onOpenChange={(open) => !open && setEditingItem(null)}
          entityType="skill"
          title="Edit Skill"
          defaultValues={editingItem ?? undefined}
          onSubmit={handleEdit}
        />
        <ConfirmDialog
          open={!!deleteTarget}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          title="Delete Skill"
          description={`Delete "${deleteTarget?.title}"?`}
          onConfirm={() => { if (deleteTarget) { remove.mutate(deleteTarget.id); notify({ title: 'Deleted', type: 'success' }); setSelectedSkill(null); setDeleteTarget(null) } }}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Header: tabs + filters + add */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          {/* Tab switcher */}
          <div className="flex bg-muted rounded-lg p-0.5 gap-0.5">
            {(['books', 'courses', 'skills'] as const).map((tab) => (
              <button
                key={tab}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  activeTab === tab
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
                onClick={() => { setActiveTab(tab); setStatusFilter('all') }}
              >
                {tabLabel[tab]}
              </button>
            ))}
          </div>

          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v as EntityStatus | 'all')}>
            <SelectTrigger className="w-[130px]"><SelectValue placeholder="Status" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="active">Active</SelectItem>
              <SelectItem value="completed">Completed</SelectItem>
              <SelectItem value="paused">Paused</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <Button size="sm" onClick={() => setDialogOpen(true)}>
          <Plus className="h-4 w-4 mr-1" /> Add {activeTab === 'books' ? 'Book' : activeTab === 'courses' ? 'Course' : 'Skill'}
        </Button>
      </div>

      {/* Reading challenge (only on books tab) */}
      {activeTab === 'books' && <ReadingChallenge />}

      {/* Item grid */}
      {items.length === 0 ? (
        <EmptyState
          icon={activeTab === 'skills' ? Brain : activeTab === 'courses' ? GraduationCap : BookOpen}
          title={`No ${tabLabel[activeTab].toLowerCase()} yet`}
          description={`Add your first ${entityType} to start tracking.`}
          actionLabel={`Add ${entityType.charAt(0).toUpperCase() + entityType.slice(1)}`}
          onAction={() => setDialogOpen(true)}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => (
            <Card
              key={item.id}
              className={activeTab === 'skills' ? 'cursor-pointer hover:bg-accent/50 transition-colors' : ''}
              onClick={activeTab === 'skills' ? () => setSelectedSkill(item) : undefined}
            >
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <CardTitle className="text-sm font-medium">{item.title}</CardTitle>
                  <div className="flex gap-1">
                    {activeTab === 'skills' && (
                      <Badge className={`text-xs capitalize ${levelColors[typeof item.metadata.level === 'string' ? item.metadata.level : 'beginner'] ?? ''}`} variant="secondary">
                        {typeof item.metadata.level === 'string' ? item.metadata.level : 'beginner'}
                      </Badge>
                    )}
                    {activeTab !== 'skills' && <Badge variant="outline" className="text-xs capitalize">{item.type}</Badge>}
                    <StatusBadge status={item.status} />
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                {typeof item.metadata.author === 'string' && (
                  <p className="text-xs text-muted-foreground">by {item.metadata.author}</p>
                )}
                {item.description && <p className="text-xs text-muted-foreground line-clamp-2">{item.description}</p>}

                {/* Rating */}
                {typeof item.metadata.rating === 'number' && item.status === 'completed' && (
                  <div className="flex items-center gap-1">
                    <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500" />
                    <span className="text-xs font-medium">{item.metadata.rating}/5</span>
                  </div>
                )}

                {/* Page progress */}
                {typeof item.metadata.totalPages === 'number' && item.metadata.totalPages > 0 && (() => {
                  const total = item.metadata.totalPages as number
                  const current = typeof item.metadata.currentPage === 'number' ? item.metadata.currentPage : 0
                  const pct = Math.min(100, Math.round((current / total) * 100))
                  return (
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <Progress value={pct} className="flex-1 h-2" />
                        <span className="text-xs text-muted-foreground shrink-0">{current}/{total}</span>
                      </div>
                      <div className="flex gap-2 items-center">
                        <Input
                          type="number"
                          value={current || ''}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10) || 0
                            update.mutate({ id: item.id, updates: { metadata: { ...item.metadata, currentPage: val }, updatedAt: new Date().toISOString() } })
                          }}
                          className="h-6 w-16 text-xs"
                          placeholder="Page"
                          min={0}
                          max={total}
                          onClick={(e) => e.stopPropagation()}
                        />
                        <span className="text-xs text-muted-foreground">of {total}</span>
                      </div>
                    </div>
                  )
                })()}

                {item.tags.length > 0 && (
                  <div className="flex gap-1 flex-wrap">
                    {item.tags.map((tag) => <span key={tag} className="text-xs bg-secondary px-1.5 py-0.5 rounded">{tag}</span>)}
                  </div>
                )}

                {/* Actions for books/courses */}
                {activeTab !== 'skills' && (
                  <div className="flex gap-1 pt-1">
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditingItem(item)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setDeleteTarget(item)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Dialogs */}
      <EntityDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        entityType={entityType}
        title={`New ${entityType.charAt(0).toUpperCase() + entityType.slice(1)}`}
        onSubmit={handleCreate}
      />
      <EntityDialog
        open={!!editingItem}
        onOpenChange={(open) => !open && setEditingItem(null)}
        entityType={(editingItem?.type as EntityType) ?? entityType}
        title={`Edit ${editingItem?.type ?? entityType}`}
        defaultValues={editingItem ?? undefined}
        onSubmit={handleEdit}
      />
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Item"
        description={`Delete "${deleteTarget?.title}"?`}
        onConfirm={() => { if (deleteTarget) { remove.mutate(deleteTarget.id); notify({ title: 'Deleted', type: 'success' }); setDeleteTarget(null) } }}
      />
    </div>
  )
}
