import { Target } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { registerWidget, type WidgetProps } from './registry'

function GoalProgress({ entities }: WidgetProps) {
  const goals = entities.filter(
    (e) => e.type === 'goal' && e.status !== 'done' && e.status !== 'archived',
  )

  if (goals.length === 0)
    return <p className="text-xs text-muted-foreground">No active goals</p>

  const today = new Date()

  return (
    <div className="space-y-2.5">
      {goals.slice(0, 5).map((g) => {
        const progress = Number(g.metadata.progress) || 0
        const daysLeft = g.dueDate
          ? Math.ceil((new Date(g.dueDate).getTime() - today.getTime()) / 86400000)
          : null
        const atRisk = daysLeft !== null && daysLeft < 14 && progress < 50

        return (
          <div key={g.id} className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm truncate flex items-center gap-1">
                <Target className="size-3 shrink-0 text-muted-foreground" />
                {g.title}
              </span>
              <div className="flex items-center gap-1 shrink-0">
                <span className="text-xs text-muted-foreground">{progress}%</span>
                {atRisk && (
                  <Badge variant="destructive" className="text-[10px] px-1 py-0">
                    {daysLeft}d left
                  </Badge>
                )}
              </div>
            </div>
            <Progress
              value={progress}
              className={`h-1.5 ${atRisk ? '[&>[data-slot=progress-indicator]]:bg-red-500' : ''}`}
            />
          </div>
        )
      })}
    </div>
  )
}

registerWidget(
  {
    id: 'goal-progress',
    name: 'Goal Progress',
    relevance: ({ entities }) => {
      const today = new Date()
      const goals = entities.filter(
        (e) => e.type === 'goal' && e.status !== 'done' && e.status !== 'archived',
      )
      if (goals.length === 0) return null
      const atRisk = goals.some((g) => {
        if (!g.dueDate) return false
        const daysLeft = Math.ceil(
          (new Date(g.dueDate).getTime() - today.getTime()) / 86400000,
        )
        const progress = Number(g.metadata.progress) || 0
        return daysLeft < 14 && progress < 50
      })
      return atRisk ? 3 : 2
    },
  },
  GoalProgress,
)
