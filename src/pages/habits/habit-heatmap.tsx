import { useMemo } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Tracker } from '@/core/types'

interface HabitHeatmapProps {
  trackers: Tracker[]
  habitId: string
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

export function HabitHeatmap({ trackers, habitId }: HabitHeatmapProps) {
  const days = useMemo(() => getLast90Days(), [])

  const checkedDays = useMemo(() => {
    const set = new Set<string>()
    for (const t of trackers) {
      if (t.entityId === habitId) {
        set.add(t.timestamp.split('T')[0])
      }
    }
    return set
  }, [trackers, habitId])

  const completionRate = days.length > 0
    ? Math.round((days.filter((d) => checkedDays.has(d)).length / days.length) * 100)
    : 0

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Last 90 days</span>
        <span className="text-xs font-medium">{completionRate}%</span>
      </div>
      <div className="flex flex-wrap gap-[2px]">
        {days.map((day) => (
          <div
            key={day}
            title={day}
            className={`w-2.5 h-2.5 rounded-sm ${
              checkedDays.has(day)
                ? 'bg-green-500 dark:bg-green-400'
                : 'bg-muted'
            }`}
          />
        ))}
      </div>
    </div>
  )
}
