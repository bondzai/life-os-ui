import { Repeat } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import type { Entity, Tracker } from '@/core/types'

interface HabitSummary {
  habit: Entity
  checkIns: number
  streak: number
}

interface StepHabitsProps {
  habits: HabitSummary[]
}

export function StepHabits({ habits }: StepHabitsProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Repeat className="h-4 w-4 text-muted-foreground" />
          Habit streaks
        </CardTitle>
      </CardHeader>
      <CardContent>
        {habits.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active habits tracked.</p>
        ) : (
          <div className="space-y-3">
            {habits.map(({ habit, checkIns, streak }) => (
              <div key={habit.id} className="space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="truncate">{habit.title}</span>
                  <span className="text-muted-foreground shrink-0">
                    {checkIns}/7 days
                    {streak > 0 && <span className="ml-2 text-green-600">{streak}d streak</span>}
                  </span>
                </div>
                <Progress value={Math.round((checkIns / 7) * 100)} className="h-2" />
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
