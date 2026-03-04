import { useMemo } from 'react'
import type { Entity } from '@/core/types'

interface WorkoutHeatmapProps {
  workouts: Entity[]
}

function getLast90Days(): string[] {
  const days: string[] = []
  const now = new Date()
  for (let i = 89; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    days.push(d.toISOString().split('T')[0])
  }
  return days
}

export function WorkoutHeatmap({ workouts }: WorkoutHeatmapProps) {
  const days = useMemo(() => getLast90Days(), [])

  const workoutDays = useMemo(() => {
    const set = new Set<string>()
    for (const w of workouts) {
      const date = (w.metadata.date as string) || w.createdAt.split('T')[0]
      set.add(date)
    }
    return set
  }, [workouts])

  const activeDays = days.filter((d) => workoutDays.has(d)).length

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Workout activity (90 days)</span>
        <span className="text-xs font-medium">{activeDays} days</span>
      </div>
      <div className="flex flex-wrap gap-[2px]">
        {days.map((day) => (
          <div
            key={day}
            title={day}
            className={`w-2.5 h-2.5 rounded-sm ${
              workoutDays.has(day)
                ? 'bg-purple-500 dark:bg-purple-400'
                : 'bg-muted'
            }`}
          />
        ))}
      </div>
    </div>
  )
}
