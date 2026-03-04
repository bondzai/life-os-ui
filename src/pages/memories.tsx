import { useState, useMemo } from 'react'
import { Plus, Camera, LayoutGrid, Clock, HardDrive, Smile, Image as ImageIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import { MemoryDialog, type MemoryFormValues } from './memories/memory-dialog'
import { MemoryCard } from './memories/memory-card'
import { MemoryLightbox } from './memories/memory-lightbox'
import { TimelineView } from './memories/timeline-view'
import { MOODS, MOOD_EMOJI, STORAGE_BUDGET_BYTES, type MemoryMood } from './memories/memory-helpers'
import { estimateBase64Size } from './memories/image-utils'
import type { Entity, EntityStatus } from '@/core/types'

type SortOption = 'newest' | 'oldest'

export function MemoriesPage() {
  const { items: allMemories, isLoading, create, update, remove } = useEntities('memory')
  const currentUser = useAuthStore((s) => s.currentUser)

  const [tab, setTab] = useState('gallery')
  const [moodFilter, setMoodFilter] = useState<string>('all')
  const [sort, setSort] = useState<SortOption>('newest')
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingMemory, setEditingMemory] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Entity | null>(null)
  const [lightboxMemory, setLightboxMemory] = useState<Entity | null>(null)

  const memories = useMemo(() => {
    let filtered = [...allMemories]
    if (moodFilter !== 'all') {
      filtered = filtered.filter((m) => m.metadata.mood === moodFilter)
    }
    filtered.sort((a, b) => {
      const dateA = (a.metadata.date as string) || a.createdAt.split('T')[0]
      const dateB = (b.metadata.date as string) || b.createdAt.split('T')[0]
      return sort === 'newest' ? dateB.localeCompare(dateA) : dateA.localeCompare(dateB)
    })
    return filtered
  }, [allMemories, moodFilter, sort])

  // Summary stats
  const totalMemories = allMemories.length
  const thisMonth = useMemo(() => {
    const prefix = new Date().toISOString().slice(0, 7)
    return allMemories.filter((m) => {
      const d = (m.metadata.date as string) || m.createdAt.split('T')[0]
      return d.startsWith(prefix)
    }).length
  }, [allMemories])

  const topMood = useMemo(() => {
    const counts: Record<string, number> = {}
    for (const m of allMemories) {
      const mood = m.metadata.mood as string
      if (mood) counts[mood] = (counts[mood] || 0) + 1
    }
    let best = ''
    let max = 0
    for (const [k, v] of Object.entries(counts)) {
      if (v > max) { best = k; max = v }
    }
    return best as MemoryMood | ''
  }, [allMemories])

  const storageUsed = useMemo(() => {
    let total = 0
    for (const m of allMemories) {
      if (typeof m.metadata.imageData === 'string') total += estimateBase64Size(m.metadata.imageData)
      if (typeof m.metadata.thumbnailData === 'string') total += estimateBase64Size(m.metadata.thumbnailData)
    }
    return total
  }, [allMemories])

  const storageUsedMB = (storageUsed / (1024 * 1024)).toFixed(1)
  const storageBudgetMB = (STORAGE_BUDGET_BYTES / (1024 * 1024)).toFixed(1)

  const handleCreate = (values: MemoryFormValues & { imageData: string; thumbnailData: string }) => {
    const tags = values.tags
      ? values.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : []
    create.mutate({
      id: crypto.randomUUID(),
      type: 'memory',
      title: values.title,
      status: 'active' as EntityStatus,
      priority: 'medium',
      tags,
      metadata: {
        imageData: values.imageData,
        thumbnailData: values.thumbnailData,
        caption: values.caption || '',
        date: values.date,
        mood: values.mood,
        location: values.location || '',
        isFavorite: false,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'shared',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Memory created', type: 'success' })
  }

  const handleEdit = (values: MemoryFormValues & { imageData: string; thumbnailData: string }) => {
    if (!editingMemory) return
    const tags = values.tags
      ? values.tags.split(',').map((t) => t.trim()).filter(Boolean)
      : []
    update.mutate({
      id: editingMemory.id,
      updates: {
        title: values.title,
        tags,
        metadata: {
          ...editingMemory.metadata,
          imageData: values.imageData,
          thumbnailData: values.thumbnailData,
          caption: values.caption || '',
          date: values.date,
          mood: values.mood,
          location: values.location || '',
        },
        updatedAt: new Date().toISOString(),
      },
    })
    setEditingMemory(null)
    notify({ title: 'Memory updated', type: 'success' })
  }

  const editDefaults = editingMemory
    ? {
        title: editingMemory.title,
        date: (editingMemory.metadata.date as string) || '',
        mood: (editingMemory.metadata.mood as string) || '',
        location: (editingMemory.metadata.location as string) || '',
        caption: (editingMemory.metadata.caption as string) || '',
        tags: editingMemory.tags.join(', '),
        imageData: (editingMemory.metadata.imageData as string) || '',
        thumbnailData: (editingMemory.metadata.thumbnailData as string) || '',
      }
    : undefined

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <ImageIcon className="h-5 w-5 text-primary" />
            <div>
              <p className="text-xs text-muted-foreground">Total Memories</p>
              <p className="text-lg font-semibold">{totalMemories}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <Camera className="h-5 w-5 text-primary" />
            <div>
              <p className="text-xs text-muted-foreground">This Month</p>
              <p className="text-lg font-semibold">{thisMonth}</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <Smile className="h-5 w-5 text-primary" />
            <div>
              <p className="text-xs text-muted-foreground">Top Mood</p>
              <p className="text-lg font-semibold">
                {topMood ? `${MOOD_EMOJI[topMood]} ${topMood}` : '—'}
              </p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-3 flex items-center gap-3">
            <HardDrive className="h-5 w-5 text-primary" />
            <div>
              <p className="text-xs text-muted-foreground">Storage</p>
              <p className="text-lg font-semibold">{storageUsedMB} / {storageBudgetMB} MB</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <TabsList>
            <TabsTrigger value="gallery" className="gap-1">
              <LayoutGrid className="h-3.5 w-3.5" /> Gallery
            </TabsTrigger>
            <TabsTrigger value="timeline" className="gap-1">
              <Clock className="h-3.5 w-3.5" /> Timeline
            </TabsTrigger>
          </TabsList>

          <div className="flex items-center gap-2">
            <Select value={moodFilter} onValueChange={setMoodFilter}>
              <SelectTrigger className="w-[140px]">
                <SelectValue placeholder="Mood" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All moods</SelectItem>
                {MOODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {MOOD_EMOJI[m]} {m.charAt(0).toUpperCase() + m.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={sort} onValueChange={(v) => setSort(v as SortOption)}>
              <SelectTrigger className="w-[120px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="newest">Newest</SelectItem>
                <SelectItem value="oldest">Oldest</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" onClick={() => setDialogOpen(true)}>
              <Plus className="h-4 w-4 mr-1" /> New Memory
            </Button>
          </div>
        </div>

        <TabsContent value="gallery" className="mt-4">
          {memories.length === 0 ? (
            <EmptyState
              icon={Camera}
              title="No memories yet"
              description="Upload your first photo to start building your memory board."
              actionLabel="New Memory"
              onAction={() => setDialogOpen(true)}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {memories.map((memory) => (
                <MemoryCard
                  key={memory.id}
                  memory={memory}
                  onEdit={setEditingMemory}
                  onDelete={setDeleteTarget}
                  onClick={setLightboxMemory}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="timeline" className="mt-4">
          {memories.length === 0 ? (
            <EmptyState
              icon={Camera}
              title="No memories yet"
              description="Upload your first photo to start building your timeline."
              actionLabel="New Memory"
              onAction={() => setDialogOpen(true)}
            />
          ) : (
            <TimelineView
              memories={memories}
              onEdit={setEditingMemory}
              onDelete={setDeleteTarget}
              onClick={setLightboxMemory}
            />
          )}
        </TabsContent>
      </Tabs>

      {/* Create dialog */}
      <MemoryDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        onSubmit={handleCreate}
      />

      {/* Edit dialog */}
      <MemoryDialog
        open={!!editingMemory}
        onOpenChange={(open) => !open && setEditingMemory(null)}
        title="Edit Memory"
        defaultValues={editDefaults}
        onSubmit={handleEdit}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete Memory"
        description={`Are you sure you want to delete "${deleteTarget?.title}"? This will free up storage.`}
        onConfirm={() => {
          if (deleteTarget) {
            remove.mutate(deleteTarget.id)
            notify({ title: 'Memory deleted', type: 'success' })
            setDeleteTarget(null)
          }
        }}
      />

      {/* Lightbox */}
      <MemoryLightbox memory={lightboxMemory} onClose={() => setLightboxMemory(null)} />
    </div>
  )
}
