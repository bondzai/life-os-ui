import { useMemo } from 'react'
import { Droplets, Minus, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'

const DAILY_GOAL = 8

export function WaterIntakeCard() {
  const { items, create, update } = useEntities('water-intake')
  const currentUser = useAuthStore((s) => s.currentUser)

  const today = new Date().toISOString().split('T')[0]

  const todayEntry = useMemo(
    () => items.find((e) => e.metadata.date === today),
    [items, today],
  )

  const count = (todayEntry?.metadata.count as number) ?? 0
  const progress = Math.min((count / DAILY_GOAL) * 100, 100)
  const goalReached = count >= DAILY_GOAL

  const setCount = (newCount: number) => {
    if (newCount < 0) return

    if (todayEntry) {
      update.mutate({
        id: todayEntry.id,
        updates: {
          title: `Water — ${newCount} glasses`,
          metadata: { ...todayEntry.metadata, count: newCount },
          updatedAt: new Date().toISOString(),
        },
      })
    } else {
      create.mutate({
        id: crypto.randomUUID(),
        type: 'water-intake',
        title: `Water — ${newCount} glasses`,
        status: 'active',
        priority: 'medium',
        tags: [],
        metadata: { date: today, count: newCount },
        ownerId: currentUser?.id ?? '',
        visibility: 'private',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    }

    if (newCount === DAILY_GOAL) {
      notify({ title: 'Daily water goal reached!', type: 'success' })
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Water Intake
        </CardTitle>
        <Droplets className="h-4 w-4 text-blue-500" />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-2xl font-bold">
            {count}
            <span className="text-sm font-normal text-muted-foreground ml-1">
              / {DAILY_GOAL} glasses
            </span>
          </p>
          {goalReached && (
            <span className="text-xs font-medium text-green-600 dark:text-green-400">
              Goal reached
            </span>
          )}
        </div>

        <Progress value={progress} className="h-2" />

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => setCount(count - 1)}
            disabled={count <= 0}
          >
            <Minus className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 w-8 p-0"
            onClick={() => setCount(count + 1)}
          >
            <Plus className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
