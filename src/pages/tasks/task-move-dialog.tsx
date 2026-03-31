import { useState, useMemo } from 'react'
import { Search, ListChecks, ArrowRight } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { isTask } from '@/core/types'
import type { Entity } from '@/core/types'

interface TaskMoveDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  task: Entity | null
  allEntities: Entity[]
  onMove: (taskId: string, parentId: string) => void
}

export function TaskMoveDialog({ open, onOpenChange, task, allEntities, onMove }: TaskMoveDialogProps) {
  const [search, setSearch] = useState('')

  // Candidate parents: any task that isn't this one, isn't archived, isn't a child of this one
  const candidates = useMemo(() => {
    if (!task) return []
    const taskId = task.id
    return allEntities
      .filter((e) =>
        isTask(e) &&
        e.id !== taskId &&
        e.status !== 'archived' &&
        e.status !== 'done' &&
        e.metadata?.parentTaskId !== taskId,
      )
      .sort((a, b) => {
        // Stories (tasks with subtasks) first
        const aHasSubs = Array.isArray(a.metadata?.subtasks) && (a.metadata.subtasks as unknown[]).length > 0
        const bHasSubs = Array.isArray(b.metadata?.subtasks) && (b.metadata.subtasks as unknown[]).length > 0
        if (aHasSubs && !bHasSubs) return -1
        if (!aHasSubs && bHasSubs) return 1
        // Then by updated (most recent first)
        return b.updatedAt.localeCompare(a.updatedAt)
      })
  }, [task, allEntities])

  const filtered = useMemo(() => {
    if (!search.trim()) return candidates.slice(0, 15)
    const q = search.toLowerCase()
    return candidates.filter((e) => e.title.toLowerCase().includes(q)).slice(0, 15)
  }, [candidates, search])

  const handleSelect = (parentId: string) => {
    if (!task) return
    onMove(task.id, parentId)
    onOpenChange(false)
    setSearch('')
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) setSearch('') }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ArrowRight className="h-4 w-4" />
            Move under...
          </DialogTitle>
          <DialogDescription>
            {task ? `"${task.title}" will become a subtask of the selected task.` : ''}
          </DialogDescription>
        </DialogHeader>

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search tasks..."
            className="pl-8 h-9 text-sm"
            autoFocus
          />
        </div>

        <div className="max-h-[300px] overflow-y-auto space-y-0.5">
          {filtered.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4 text-center">No matching tasks</p>
          ) : (
            filtered.map((entity) => {
              const hasSubs = Array.isArray(entity.metadata?.subtasks) && (entity.metadata.subtasks as unknown[]).length > 0
              return (
                <button
                  key={entity.id}
                  onClick={() => handleSelect(entity.id)}
                  className="flex items-center gap-2 w-full px-3 py-2 rounded-md text-left hover:bg-accent transition-colors cursor-pointer"
                >
                  {hasSubs && <ListChecks className="h-3.5 w-3.5 text-muted-foreground shrink-0" />}
                  <span className="text-sm flex-1 truncate">{entity.title}</span>
                  {hasSubs && (
                    <span className="text-[10px] text-muted-foreground shrink-0">
                      {(entity.metadata.subtasks as unknown[]).length} subtasks
                    </span>
                  )}
                </button>
              )
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
