import { AlertTriangle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { registerWidget, type WidgetProps } from './registry'

const priorityColor: Record<string, string> = {
  urgent: 'text-red-500',
  high: 'text-orange-500',
  medium: 'text-amber-500',
  low: 'text-muted-foreground',
}

function OverdueTasks({ entities }: WidgetProps) {
  const today = new Date().toISOString().split('T')[0]
  const overdue = entities
    .filter(
      (e) =>
        e.type === 'task' &&
        e.dueDate &&
        e.dueDate < today &&
        e.status !== 'done' &&
        e.status !== 'archived',
    )
    .sort((a, b) => {
      const pa = ['urgent', 'high', 'medium', 'low'].indexOf(a.priority)
      const pb = ['urgent', 'high', 'medium', 'low'].indexOf(b.priority)
      return pa - pb
    })

  if (overdue.length === 0)
    return <p className="text-xs text-muted-foreground">All caught up!</p>

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-red-500">
        <AlertTriangle className="size-3.5" />
        <span>{overdue.length} overdue</span>
      </div>
      {overdue.slice(0, 5).map((task) => (
        <div key={task.id} className="flex items-center justify-between gap-2">
          <span className="text-sm truncate">{task.title}</span>
          <Badge variant="outline" className={`text-xs shrink-0 ${priorityColor[task.priority]}`}>
            {task.priority}
          </Badge>
        </div>
      ))}
    </div>
  )
}

registerWidget(
  {
    id: 'overdue-tasks',
    name: 'Overdue Tasks',
    relevance: ({ entities, today }) => {
      const overdue = entities.filter(
        (e) =>
          e.type === 'task' &&
          e.dueDate &&
          e.dueDate < today &&
          e.status !== 'done' &&
          e.status !== 'archived',
      )
      if (overdue.length === 0) return null
      return overdue.length >= 3 ? 3 : 2
    },
  },
  OverdueTasks,
)
