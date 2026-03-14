import { useDroppable } from '@dnd-kit/core'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { DraggableTaskCard } from './draggable-task-card'
import type { Entity, EntityStatus } from '@/core/types'

interface KanbanColumnProps {
  status: EntityStatus
  label: string
  tasks: Entity[]
  onToggleComplete: (task: Entity) => void
  onMoveToStatus: (task: Entity, status: EntityStatus) => void
  onEdit: (task: Entity) => void
  onDelete: (task: Entity) => void
  onSnooze?: (task: Entity, days: number) => void
}

export function KanbanColumn({
  status,
  label,
  tasks,
  onToggleComplete,
  onMoveToStatus,
  onEdit,
  onDelete,
  onSnooze,
}: KanbanColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  const taskIds = tasks.map((t) => t.id)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-1">
        <h3 className="text-sm font-medium">
          {label}
          <span className="ml-1.5 text-xs text-muted-foreground">({tasks.length})</span>
        </h3>
      </div>
      <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
        <div
          ref={setNodeRef}
          className={`space-y-2 min-h-[100px] rounded-lg border border-dashed p-2 transition-colors ${
            isOver ? 'border-primary bg-accent/40' : ''
          }`}
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
            />
          ))}
          {tasks.length === 0 && (
            <p className="text-xs text-muted-foreground text-center py-4">No tasks</p>
          )}
        </div>
      </SortableContext>
    </div>
  )
}
