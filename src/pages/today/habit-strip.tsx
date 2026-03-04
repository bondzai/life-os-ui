import { Repeat } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Entity, Tracker } from '@/core/types'

interface HabitWithStatus {
  habit: Entity
  checkedToday: boolean
  streak: number
}

interface HabitStripProps {
  habits: HabitWithStatus[]
  onCheckIn: (habit: Entity) => void
}

export function HabitStrip({ habits, onCheckIn }: HabitStripProps) {
  const doneCount = habits.filter((h) => h.checkedToday).length

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Repeat className="h-4 w-4 text-muted-foreground" />
          Habits
          {habits.length > 0 && (
            <span className="text-xs text-muted-foreground ml-auto">
              {doneCount}/{habits.length}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {habits.length === 0 ? (
          <p className="text-sm text-muted-foreground">No active habits.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {habits.map(({ habit, checkedToday, streak }) => (
              <Button
                key={habit.id}
                size="sm"
                variant={checkedToday ? 'default' : 'outline'}
                className="gap-1.5"
                onClick={() => !checkedToday && onCheckIn(habit)}
                disabled={checkedToday}
              >
                <span
                  className={`w-2 h-2 rounded-full ${
                    checkedToday ? 'bg-green-400' : 'bg-muted-foreground/30'
                  }`}
                />
                {habit.title}
                {streak > 0 && (
                  <span className="text-xs opacity-70">{streak}d</span>
                )}
              </Button>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
