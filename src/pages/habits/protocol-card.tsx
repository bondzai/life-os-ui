import { useMemo } from 'react'
import { Flame, Pencil, Trash2, ListChecks } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { PriorityBadge } from '@/core/components/priority-badge'
import type { Entity } from '@/core/types'
import type { ProtocolStep } from './protocol-dialog'

interface ProtocolCardProps {
  habit: Entity
  todayCompletedSteps: string[]
  onToggleStep: (habit: Entity, stepId: string, completed: boolean) => void
  onEdit: (habit: Entity) => void
  onDelete: (habit: Entity) => void
}

export function ProtocolCard({
  habit,
  todayCompletedSteps,
  onToggleStep,
  onEdit,
  onDelete,
}: ProtocolCardProps) {
  const steps = useMemo(() => {
    const raw = habit.metadata.steps
    if (!Array.isArray(raw)) return []
    return (raw as ProtocolStep[]).sort((a, b) => a.order - b.order)
  }, [habit.metadata.steps])

  const completedCount = todayCompletedSteps.length
  const totalSteps = steps.length
  const allDone = totalSteps > 0 && completedCount >= totalSteps
  const pct = totalSteps > 0 ? Math.round((completedCount / totalSteps) * 100) : 0

  const streak = typeof habit.metadata.streak === 'number' ? habit.metadata.streak : 0
  const frequency = typeof habit.metadata.frequency === 'string' ? habit.metadata.frequency : 'daily'

  return (
    <Card className={allDone ? 'border-green-500/50 bg-green-50/30 dark:bg-green-950/10' : ''}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <ListChecks className="h-4 w-4 text-muted-foreground shrink-0" />
            <CardTitle className="text-sm font-medium truncate">{habit.title}</CardTitle>
          </div>
          <div className="flex gap-1 shrink-0">
            <Badge variant="outline" className="text-xs capitalize">{frequency}</Badge>
            <PriorityBadge priority={habit.priority} />
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        {habit.description && (
          <p className="text-xs text-muted-foreground line-clamp-1">{habit.description}</p>
        )}

        {/* Step checklist */}
        <div className="space-y-1.5">
          {steps.map((step) => {
            const isDone = todayCompletedSteps.includes(step.id)
            return (
              <label
                key={step.id}
                className={`flex items-center gap-2.5 py-1 px-2 rounded-md cursor-pointer transition-colors hover:bg-accent/50 ${
                  isDone ? 'bg-accent/30' : ''
                }`}
              >
                <Checkbox
                  checked={isDone}
                  onCheckedChange={(checked) => onToggleStep(habit, step.id, !!checked)}
                  className="shrink-0"
                />
                <span className={`text-sm ${isDone ? 'line-through text-muted-foreground' : ''}`}>
                  {step.label}
                </span>
              </label>
            )
          })}
        </div>

        {/* Progress bar */}
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">{completedCount}/{totalSteps} steps</span>
            <span className={pct === 100 ? 'text-green-600 font-medium' : 'text-muted-foreground'}>{pct}%</span>
          </div>
          <Progress value={pct} className="h-1.5" />
        </div>

        {/* Streak */}
        <div className="flex items-center gap-1.5">
          <Flame className="h-4 w-4 text-orange-500" />
          <span className="text-sm font-medium">{streak}</span>
          <span className="text-xs text-muted-foreground">day streak</span>
          {streak >= 90 && <Badge className="text-xs bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300">90d</Badge>}
          {streak >= 30 && streak < 90 && <Badge className="text-xs bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300">30d</Badge>}
          {streak >= 7 && streak < 30 && <Badge className="text-xs bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300">7d</Badge>}
        </div>

        {/* Actions */}
        <div className="flex gap-1 pt-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onEdit(habit)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onDelete(habit)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
