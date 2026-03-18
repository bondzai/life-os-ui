import { useState, useMemo } from 'react'
import { Plus, BookOpen, Pencil, Trash2, Star } from 'lucide-react'
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
import { StatusBadge } from '@/core/components/status-badge'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import { SavedFilterBar } from '@/core/components/saved-filter-bar'
import { ReadingChallenge } from './reading/reading-challenge'
import type { Entity, EntityStatus, EntityType } from '@/core/types'

export function ReadingPage() {
  const { items: allEntities, isLoading, create, update, remove } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)

  const [typeFilter, setTypeFilter] = useState<'all' | 'book' | 'course'>('all')
  const [statusFilter, setStatusFilter] = useState<EntityStatus | 'all'>('all')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [dialogType, setDialogType] = useState<'book' | 'course'>('book')
  const [editingItem, setEditingItem] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)

  const items = useMemo(() => {
    let filtered = allEntities.filter(
      (e) => e.type === 'book' || e.type === 'course',
    )
    if (typeFilter !== 'all') {
      filtered = filtered.filter((e) => e.type === typeFilter)
    }
    if (statusFilter !== 'all') {
      filtered = filtered.filter((e) => e.status === statusFilter)
    }
    return filtered
  }, [allEntities, typeFilter, statusFilter])

  const openCreateDialog = (type: 'book' | 'course') => {
    setDialogType(type)
    setDialogOpen(true)
  }

  const handleCreate = (values: Record<string, unknown>) => {
    const tags =
      typeof values.tags === 'string'
        ? values.tags.split(',').map((t: string) => t.trim()).filter(Boolean)
        : []
    create.mutate({
      id: crypto.randomUUID(),
      type: dialogType as EntityType,
      title: values.title as string,
      description: (values.description as string) || undefined,
      status: (values.status as EntityStatus) || 'todo',
      priority: (values.priority as Entity['priority']) || 'medium',
      tags,
      metadata: {},
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: `${dialogType === 'book' ? 'Book' : 'Course'} created`, type: 'success' })
  }

  const handleEdit = (values: Record<string, unknown>) => {
    if (!editingItem) return
    const tags =
      typeof values.tags === 'string'
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
    notify({ title: 'Item updated', type: 'success' })
    setEditingItem(null)
  }

  const getRating = (item: Entity): number | null => {
    const r = item.metadata.rating
    return typeof r === 'number' ? r : null
  }

  const getAuthor = (item: Entity): string | null => {
    const a = item.metadata.author
    return typeof a === 'string' ? a : null
  }

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <Select
            value={typeFilter}
            onValueChange={(v) => setTypeFilter(v as 'all' | 'book' | 'course')}
          >
            <SelectTrigger className="w-[130px]">
              <SelectValue placeholder="Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="book">Books</SelectItem>
              <SelectItem value="course">Courses</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={statusFilter}
            onValueChange={(v) => setStatusFilter(v as EntityStatus | 'all')}
          >
            <SelectTrigger className="w-[140px]">
              <SelectValue placeholder="Status" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="todo">To Do</SelectItem>
              <SelectItem value="done">Done</SelectItem>
              <SelectItem value="in-progress">In Progress</SelectItem>
              <SelectItem value="archived">Archived</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => openCreateDialog('book')}>
            <Plus className="h-4 w-4 mr-1" /> Add Book
          </Button>
          <Button size="sm" variant="outline" onClick={() => openCreateDialog('course')}>
            <Plus className="h-4 w-4 mr-1" /> Add Course
          </Button>
        </div>
      </div>

      {/* Reading Challenge */}
      <ReadingChallenge />

      {/* Saved filters */}
      <SavedFilterBar
        moduleKey="reading"
        currentCriteria={{ type: typeFilter, status: statusFilter }}
        onApply={(c) => {
          setTypeFilter((c.type as 'all' | 'book' | 'course') || 'all')
          setStatusFilter((c.status as EntityStatus | 'all') || 'all')
        }}
      />

      {/* Grid */}
      {items.length === 0 ? (
        <EmptyState
          icon={BookOpen}
          title="No reading items yet"
          description="Add a book or course to start tracking your reading."
          actionLabel="Add Book"
          onAction={() => openCreateDialog('book')}
        />
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {items.map((item) => {
            const author = getAuthor(item)
            const rating = getRating(item)

            return (
              <Card key={item.id}>
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-sm font-medium">
                      {item.title}
                    </CardTitle>
                    <div className="flex gap-1">
                      <Badge variant="outline" className="text-xs capitalize">
                        {item.type}
                      </Badge>
                      <StatusBadge status={item.status} />
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  {author && (
                    <p className="text-xs text-muted-foreground">by {author}</p>
                  )}
                  {item.description && (
                    <p className="text-xs text-muted-foreground line-clamp-2">
                      {item.description}
                    </p>
                  )}
                  {rating !== null && item.status === 'done' && (
                    <div className="flex items-center gap-1">
                      <Star className="h-3.5 w-3.5 text-amber-500 fill-amber-500" />
                      <span className="text-xs font-medium">{rating}/5</span>
                    </div>
                  )}
                  {/* Page progress */}
                  {(() => {
                    const totalPages = typeof item.metadata.totalPages === 'number' ? item.metadata.totalPages : 0
                    const currentPage = typeof item.metadata.currentPage === 'number' ? item.metadata.currentPage : 0
                    if (totalPages <= 0) return null
                    const pct = Math.min(100, Math.round((currentPage / totalPages) * 100))
                    return (
                      <div className="space-y-1">
                        <div className="flex items-center gap-2">
                          <Progress value={pct} className="flex-1 h-2" />
                          <span className="text-xs text-muted-foreground shrink-0">{currentPage}/{totalPages}</span>
                        </div>
                        <div className="flex gap-2 items-center">
                          <Input
                            type="number"
                            value={currentPage || ''}
                            onChange={(e) => {
                              const val = parseInt(e.target.value, 10) || 0
                              update.mutate({
                                id: item.id,
                                updates: {
                                  metadata: { ...item.metadata, currentPage: val },
                                  updatedAt: new Date().toISOString(),
                                },
                              })
                            }}
                            className="h-6 w-16 text-xs"
                            placeholder="Page"
                            min={0}
                            max={totalPages}
                          />
                          <span className="text-xs text-muted-foreground">of {totalPages}</span>
                        </div>
                      </div>
                    )
                  })()}
                  {item.tags.length > 0 && (
                    <div className="flex gap-1 flex-wrap">
                      {item.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-xs bg-secondary px-1.5 py-0.5 rounded"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Actions */}
                  <div className="flex gap-1 pt-1">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => setEditingItem(item)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={() => setDeleteTarget(item)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
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
        entityType={dialogType}
        title={`New ${dialogType === 'book' ? 'Book' : 'Course'}`}
        onSubmit={handleCreate}
      />

      {/* Edit dialog */}
      <EntityDialog
        open={!!editingItem}
        onOpenChange={(open) => !open && setEditingItem(null)}
        entityType={(editingItem?.type as 'book' | 'course') ?? 'book'}
        title={`Edit ${editingItem?.type === 'course' ? 'Course' : 'Book'}`}
        defaultValues={editingItem ?? undefined}
        onSubmit={handleEdit}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Item"
        description={`Are you sure you want to delete "${deleteTarget?.title}"?`}
        onConfirm={() => {
          if (deleteTarget) {
            remove.mutate(deleteTarget.id)
            notify({ title: 'Item deleted', type: 'success' })
            setDeleteTarget(null)
          }
        }}
      />
    </div>
  )
}
