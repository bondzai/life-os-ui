import { useState } from 'react'
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCorners,
  type DragStartEvent,
  type DragEndEvent,
} from '@dnd-kit/core'
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import { KanbanColumn } from './kanban-column'
import { TaskCard } from './task-card'
import type { Entity, EntityStatus } from '@/core/types'

const kanbanColumns: { status: EntityStatus; label: string }[] = [
  { status: 'active', label: 'Active' },
  { status: 'paused', label: 'Paused' },
  { status: 'completed', label: 'Completed' },
  { status: 'archived', label: 'Archived' },
]

interface KanbanBoardProps {
  tasks: Entity[]
  onToggleComplete: (task: Entity) => void
  onMoveToStatus: (task: Entity, status: EntityStatus) => void
  onEdit: (task: Entity) => void
  onDelete: (task: Entity) => void
}

export function KanbanBoard({
  tasks,
  onToggleComplete,
  onMoveToStatus,
  onEdit,
  onDelete,
}: KanbanBoardProps) {
  const [activeTask, setActiveTask] = useState<Entity | null>(null)

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const handleDragStart = (event: DragStartEvent) => {
    const task = tasks.find((t) => t.id === event.active.id)
    setActiveTask(task ?? null)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(null)
    const { active, over } = event
    if (!over) return

    const task = tasks.find((t) => t.id === active.id)
    if (!task) return

    // Determine target status: if dropped on a column, over.id is the status string;
    // if dropped on another card, read its status from data
    const columnStatuses = kanbanColumns.map((c) => c.status)
    let targetStatus: EntityStatus | undefined

    if (columnStatuses.includes(over.id as EntityStatus)) {
      targetStatus = over.id as EntityStatus
    } else {
      targetStatus = (over.data.current as { status?: EntityStatus })?.status
    }

    if (targetStatus && targetStatus !== task.status) {
      onMoveToStatus(task, targetStatus)
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {kanbanColumns.map((col) => (
          <KanbanColumn
            key={col.status}
            status={col.status}
            label={col.label}
            tasks={tasks.filter((t) => t.status === col.status)}
            onToggleComplete={onToggleComplete}
            onMoveToStatus={onMoveToStatus}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </div>
      <DragOverlay>
        {activeTask && (
          <TaskCard
            task={activeTask}
            onToggleComplete={() => {}}
            onMoveToStatus={() => {}}
            onEdit={() => {}}
            onDelete={() => {}}
          />
        )}
      </DragOverlay>
    </DndContext>
  )
}
