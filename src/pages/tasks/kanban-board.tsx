import { useState, useMemo } from 'react'
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

const BOARD_COLUMNS = [
  { status: 'active' as EntityStatus, label: 'TO DO', color: '#2563eb', bgColor: '#2563eb10' },
  { status: 'paused' as EntityStatus, label: 'IN PROGRESS', color: '#d97706', bgColor: '#d9770610' },
  { status: 'completed' as EntityStatus, label: 'DONE', color: '#16a34a', bgColor: '#16a34a10' },
] as const

interface KanbanBoardProps {
  tasks: Entity[]
  onToggleComplete: (task: Entity) => void
  onMoveToStatus: (task: Entity, status: EntityStatus) => void
  onEdit: (task: Entity) => void
  onDelete: (task: Entity) => void
  onSnooze?: (task: Entity, days: number) => void
  onTaskClick?: (task: Entity) => void
  onQuickAdd?: (title: string, status: EntityStatus) => void
}

export function KanbanBoard({
  tasks,
  onToggleComplete,
  onMoveToStatus,
  onEdit,
  onDelete,
  onSnooze,
  onTaskClick,
  onQuickAdd,
}: KanbanBoardProps) {
  const [activeTask, setActiveTask] = useState<Entity | null>(null)

  const boardTasks = useMemo(() => tasks.filter((t) => t.status !== 'archived'), [tasks])

  const tasksByStatus = useMemo(() => {
    const map = new Map<EntityStatus, Entity[]>()
    for (const col of BOARD_COLUMNS) {
      map.set(col.status, boardTasks.filter((t) => t.status === col.status))
    }
    return map
  }, [boardTasks])

  const taskMap = useMemo(() => new Map(boardTasks.map((t) => [t.id, t])), [boardTasks])

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 5 },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    }),
  )

  const handleDragStart = (event: DragStartEvent) => {
    setActiveTask(taskMap.get(event.active.id as string) ?? null)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setActiveTask(null)
    const { active, over } = event
    if (!over) return

    const task = taskMap.get(active.id as string)
    if (!task) return

    const columnStatuses = BOARD_COLUMNS.map((c) => c.status)
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
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {BOARD_COLUMNS.map((col) => (
          <KanbanColumn
            key={col.status}
            status={col.status}
            label={col.label}
            color={col.color}
            bgColor={col.bgColor}
            tasks={tasksByStatus.get(col.status) ?? []}
            onToggleComplete={onToggleComplete}
            onMoveToStatus={onMoveToStatus}
            onEdit={onEdit}
            onDelete={onDelete}
            onSnooze={onSnooze}
            onTaskClick={onTaskClick}
            onQuickAdd={onQuickAdd}
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
