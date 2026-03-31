import { useState, useRef, useEffect } from 'react'
import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DraggableTaskCard } from './draggable-task-card'
import type { Entity, EntityStatus } from '@/core/types'

interface KanbanColumnProps {
  status: EntityStatus
  label: string
  color: string
  bgColor: string
  tasks: Entity[]
  onToggleComplete: (task: Entity) => void
  onMoveToStatus: (task: Entity, status: EntityStatus) => void
  onEdit: (task: Entity) => void
  onDelete: (task: Entity) => void
  onSnooze?: (task: Entity, days: number) => void
  onTaskClick?: (task: Entity) => void
  onQuickAdd?: (title: string, status: EntityStatus) => void
  onToggleSubtask?: (taskId: string, subtaskId: string) => void
  onMoveUnder?: (taskId: string, parentId: string) => void
  allTasks?: Entity[]
}

export function KanbanColumn({
  status,
  label,
  color,
  bgColor,
  tasks,
  onToggleComplete,
  onMoveToStatus,
  onEdit,
  onDelete,
  onSnooze,
  onTaskClick,
  onQuickAdd,
  onToggleSubtask,
  onMoveUnder,
  allTasks,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  const taskIds = tasks.map((t) => t.id)

  const [isAdding, setIsAdding] = useState(false)
  const [newTitle, setNewTitle] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (isAdding) inputRef.current?.focus()
  }, [isAdding])

  const handleSubmit = () => {
    const trimmed = newTitle.trim()
    if (trimmed && onQuickAdd) {
      onQuickAdd(trimmed, status)
    }
    setNewTitle('')
    setIsAdding(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    } else if (e.key === 'Escape') {
      setNewTitle('')
      setIsAdding(false)
    }
  }

  return (
    <div className="flex flex-col gap-0">
      {/* Header */}
      <div
        className="flex items-center gap-2 px-3 py-2 rounded-t-lg"
        style={{ borderLeft: `3px solid ${color}` }}
      >
        <h3 className="text-xs font-semibold uppercase tracking-wide">{label}</h3>
        <span className="text-[10px] font-medium text-muted-foreground bg-muted rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center">
          {tasks.length}
        </span>
      </div>

      {/* Drop zone */}
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className="flex flex-col gap-1 min-h-[200px] rounded-b-lg border border-border/50 p-2 transition-all"
          style={{
            backgroundColor: bgColor,
            ...(isOver ? { borderColor: color, transform: 'scale(1.01)' } : {}),
          }}
        >
          {tasks.map((task) => (
            <DraggableTaskCard
              key={task.id}
              task={task}
              onToggleComplete={onToggleComplete}
              onMoveToStatus={onMoveToStatus}
              onEdit={onEdit}
              onDelete={onDelete}
              onSnooze={onSnooze}
              onTaskClick={onTaskClick}
              onToggleSubtask={onToggleSubtask}
              onMoveUnder={onMoveUnder}
              allTasks={allTasks}
            />
          ))}

          {tasks.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-8">No tasks</p>
          )}

          {/* Inline add */}
          {isAdding ? (
            <Input
              ref={inputRef}
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={handleSubmit}
              placeholder="Task title..."
              className="h-8 text-sm mt-1"
            />
          ) : (
            onQuickAdd && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full h-7 text-xs text-muted-foreground hover:text-foreground mt-1 gap-1"
                onClick={() => setIsAdding(true)}
              >
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            )
          )}
        </div>
      </SortableContext>
    </div>
  )
}
