import { Flame, Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { registerWidget, type WidgetProps } from './registry'

function todayStr() {
  return new Date().toISOString().split('T')[0]
}

function StreakTracker({ entities, trackers }: WidgetProps) {
  const today = todayStr()
  const habits = entities.filter(
    (e) => e.type === 'habit' && e.status !== 'archived',
  )

  const habitData = habits.map((h) => {
    const habitTrackers = trackers
      .filter((t) => t.entityId === h.id)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))

    const checkedToday = habitTrackers.some(
      (t) => t.timestamp.split('T')[0] === today,
    )

    // Calculate streak
    let streak = 0
    const seen = new Set(habitTrackers.map((t) => t.timestamp.split('T')[0]))
    for (let i = 0; i < 365; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      const ds = d.toISOString().split('T')[0]
      if (seen.has(ds)) streak++
      else if (i > 0) break
    }

    return { habit: h, streak, checkedToday }
  })

  if (habitData.length === 0) return <p className="text-xs text-muted-foreground">No habits tracked</p>

  return (
    <div className="space-y-2">
      {habitData.slice(0, 5).map(({ habit, streak, checkedToday }) => (
        <div key={habit.id} className="flex items-center justify-between gap-2">
          <span className="text-sm truncate">{habit.title}</span>
          <div className="flex items-center gap-1.5 shrink-0">
            {streak > 0 && (
              <Badge variant="secondary" className="text-xs gap-0.5 px-1.5">
                <Flame className="size-3 text-orange-500" />
                {streak}
              </Badge>
            )}
            {checkedToday ? (
              <Check className="size-4 text-emerald-500" />
            ) : (
              <span className="size-4 rounded-full border border-muted-foreground/30" />
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

registerWidget(
  {
    id: 'streak-tracker',
    name: 'Habit Streaks',
    relevance: ({ entities, trackers }) => {
      const today = new Date().toISOString().split('T')[0]
      const habits = entities.filter(
        (e) => e.type === 'habit' && e.status !== 'archived',
      )
      if (habits.length === 0) return null

      const hasUrgent = habits.some((h) => {
        const hTrackers = trackers.filter((t) => t.entityId === h.id)
        const checkedToday = hTrackers.some(
          (t) => t.timestamp.split('T')[0] === today,
        )
        if (checkedToday) return false
        const seen = new Set(hTrackers.map((t) => t.timestamp.split('T')[0]))
        let streak = 0
        for (let i = 1; i < 365; i++) {
          const d = new Date()
          d.setDate(d.getDate() - i)
          if (seen.has(d.toISOString().split('T')[0])) streak++
          else break
        }
        return streak >= 7
      })

      return hasUrgent ? 3 : 2
    },
  },
  StreakTracker,
)
