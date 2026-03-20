import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { TaskCard, type TaskCardProps } from './task-card'
import type { Entity } from '@/core/types'

interface DraggableTaskCardProps extends TaskCardProps {
  onTaskClick?: (task: Entity) => void
}

export function DraggableTaskCard({ onTaskClick, ...props }: DraggableTaskCardProps) {
  const { task } = props
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { task, status: task.status },
  })

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : undefined,
  }

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <TaskCard
        {...props}
        onClick={onTaskClick ? () => onTaskClick(task) : undefined}
      />
    </div>
  )
}
