import { TrendingUp, TrendingDown, Minus, CheckCircle2 } from 'lucide-react'
import { registerWidget, type WidgetProps } from './registry'
import { isTask } from '@/core/types'

function startOfWeek(d: Date): Date {
  const r = new Date(d)
  const day = r.getDay()
  r.setDate(r.getDate() - (day === 0 ? 6 : day - 1))
  r.setHours(0, 0, 0, 0)
  return r
}

function WeeklyVelocity({ entities }: WidgetProps) {
  const now = new Date()
  const thisWeekStart = startOfWeek(now)
  const lastWeekStart = new Date(thisWeekStart)
  lastWeekStart.setDate(lastWeekStart.getDate() - 7)

  const doneTasks = entities.filter(
    (e) => isTask(e) && e.status === 'done',
  )

  const thisWeek = doneTasks.filter(
    (t) => new Date(t.updatedAt) >= thisWeekStart,
  ).length
  const lastWeek = doneTasks.filter(
    (t) =>
      new Date(t.updatedAt) >= lastWeekStart &&
      new Date(t.updatedAt) < thisWeekStart,
  ).length

  const delta = thisWeek - lastWeek
  const pctChange = lastWeek > 0 ? Math.round((delta / lastWeek) * 100) : 0

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <CheckCircle2 className="size-4 text-emerald-500" />
          <span className="text-lg font-semibold">{thisWeek}</span>
          <span className="text-xs text-muted-foreground">this week</span>
        </div>
        <div className="flex items-center gap-1 text-sm">
          {delta > 0 ? (
            <TrendingUp className="size-4 text-emerald-500" />
          ) : delta < 0 ? (
            <TrendingDown className="size-4 text-red-500" />
          ) : (
            <Minus className="size-4 text-muted-foreground" />
          )}
          <span
            className={
              delta > 0
                ? 'text-emerald-500'
                : delta < 0
                  ? 'text-red-500'
                  : 'text-muted-foreground'
            }
          >
            {delta > 0 ? '+' : ''}
            {delta}
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span>Last week: {lastWeek}</span>
        {lastWeek > 0 && (
          <span className={delta >= 0 ? 'text-emerald-500' : 'text-red-500'}>
            ({pctChange > 0 ? '+' : ''}{pctChange}%)
          </span>
        )}
      </div>
    </div>
  )
}

registerWidget(
  {
    id: 'weekly-velocity',
    name: 'Weekly Task Velocity',
    relevance: () => 2,
  },
  WeeklyVelocity,
)
