import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { TaskCard, type TaskCardProps } from './task-card'

export function DraggableTaskCard(props: TaskCardProps) {
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
    <TaskCard
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      {...props}
      showStatusMove={false}
    />
  )
}
