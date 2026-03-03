import { useState, useMemo } from 'react'
import { Plus, Users, ClipboardList, Activity, CalendarDays } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import {
  CHORE_CATEGORIES,
  ASSIGNEES,
  type ChoreCategory,
  type ChoreFrequency,
} from './family/family-helpers'
import { ChoreDialog, type ChoreFormValues } from './family/chore-dialog'
import { ChoreCard } from './family/chore-card'
import { ActivityFeed } from './family/activity-feed'
import type { Entity } from '@/core/types'

export function FamilyPage() {
  const { items: chores, create: createChore, update: updateChore, remove: removeChore } = useEntities('chore')
  const { items: allEntities } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)

  const [tab, setTab] = useState('chores')
  const [categoryFilter, setCategoryFilter] = useState('all')
  const [assigneeFilter, setAssigneeFilter] = useState('all')

  // Dialogs
  const [choreDialogOpen, setChoreDialogOpen] = useState(false)
  const [editingChore, setEditingChore] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)

  // Shared entities for activity feed (most recent 50)
  const sharedActivity = useMemo(
    () =>
      allEntities
        .filter((e) => e.visibility === 'shared')
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 50),
    [allEntities],
  )

  // Summary stats
  const today = new Date().toISOString().split('T')[0]
  const choresDueToday = useMemo(
    () => chores.filter((c) => c.dueDate && c.dueDate <= today).length,
    [chores, today],
  )
  const myChores = useMemo(
    () => chores.filter((c) => c.metadata.assigneeId === currentUser?.id).length,
    [chores, currentUser],
  )
  const sharedTasks = useMemo(
    () => allEntities.filter((e) => e.type === 'task' && e.visibility === 'shared' && e.status === 'active').length,
    [allEntities],
  )

  // Filtered chores
  const filteredChores = useMemo(() => {
    let result = chores
    if (categoryFilter !== 'all') result = result.filter((c) => c.metadata.category === categoryFilter)
    if (assigneeFilter !== 'all') result = result.filter((c) => c.metadata.assigneeId === assigneeFilter)
    return result
  }, [chores, categoryFilter, assigneeFilter])

  // CRUD handlers
  const handleCreateChore = (values: ChoreFormValues) => {
    createChore.mutate({
      id: crypto.randomUUID(),
      type: 'chore',
      title: values.title,
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: {
        category: values.category,
        frequency: values.frequency,
        assigneeId: values.assigneeId,
        note: values.note,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'shared',
      dueDate: values.dueDate || undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Chore added', type: 'success' })
  }

  const handleEditChore = (values: ChoreFormValues) => {
    if (!editingChore) return
    updateChore.mutate({
      id: editingChore.id,
      updates: {
        title: values.title,
        metadata: {
          ...editingChore.metadata,
          category: values.category,
          frequency: values.frequency,
          assigneeId: values.assigneeId,
          note: values.note,
        },
        dueDate: values.dueDate || undefined,
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Chore updated', type: 'success' })
    setEditingChore(null)
  }

  const handleDelete = () => {
    if (!deleteTarget) return
    removeChore.mutate(deleteTarget.id)
    notify({ title: 'Chore deleted', type: 'success' })
    setDeleteTarget(null)
  }

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Chores</CardTitle>
            <ClipboardList className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{chores.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Due / Overdue</CardTitle>
            <CalendarDays className="h-4 w-4 text-red-500" />
          </CardHeader>
          <CardContent>
            <p className={`text-2xl font-bold ${choresDueToday > 0 ? 'text-red-600' : ''}`}>{choresDueToday}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">My Chores</CardTitle>
            <Users className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{myChores}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Shared Tasks</CardTitle>
            <Activity className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{sharedTasks}</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <TabsList>
            <TabsTrigger value="chores">Chores</TabsTrigger>
            <TabsTrigger value="activity">Activity</TabsTrigger>
          </TabsList>
          {tab === 'chores' && (
            <Button size="sm" onClick={() => setChoreDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> Add Chore
            </Button>
          )}
        </div>

        {/* Chores Tab */}
        <TabsContent value="chores" className="space-y-4">
          <div className="flex gap-3 flex-wrap">
            <Select value={categoryFilter} onValueChange={setCategoryFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Category" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Categories</SelectItem>
                {CHORE_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {c.charAt(0).toUpperCase() + c.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={assigneeFilter} onValueChange={setAssigneeFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Assignee" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Everyone</SelectItem>
                {ASSIGNEES.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {filteredChores.length === 0 ? (
            <EmptyState
              icon={ClipboardList}
              title="No chores yet"
              description="Add household chores and assign them to family members."
              actionLabel="New Chore"
              onAction={() => setChoreDialogOpen(true)}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredChores.map((chore) => (
                <ChoreCard
                  key={chore.id}
                  chore={chore}
                  onEdit={setEditingChore}
                  onDelete={setDeleteTarget}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* Activity Tab */}
        <TabsContent value="activity" className="space-y-4">
          {sharedActivity.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No shared activity"
              description="Shared entities from all modules will appear here."
            />
          ) : (
            <ActivityFeed entities={sharedActivity} />
          )}
        </TabsContent>
      </Tabs>

      {/* Create dialog */}
      <ChoreDialog
        open={choreDialogOpen}
        onOpenChange={setChoreDialogOpen}
        onSubmit={handleCreateChore}
      />

      {/* Edit dialog */}
      <ChoreDialog
        open={!!editingChore}
        onOpenChange={(open) => !open && setEditingChore(null)}
        title="Edit Chore"
        defaultValues={
          editingChore
            ? {
                title: editingChore.title,
                category: editingChore.metadata.category as ChoreCategory,
                frequency: editingChore.metadata.frequency as ChoreFrequency,
                assigneeId: editingChore.metadata.assigneeId as string,
                dueDate: editingChore.dueDate || '',
                note: (editingChore.metadata.note as string) || '',
              }
            : undefined
        }
        onSubmit={handleEditChore}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Chore"
        description={`Are you sure you want to delete "${deleteTarget?.title}"?`}
        onConfirm={handleDelete}
      />
    </div>
  )
}
