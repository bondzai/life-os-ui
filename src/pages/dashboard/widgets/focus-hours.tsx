import { useMemo } from 'react'
import { Brain } from 'lucide-react'
import { BarChart, Bar, ResponsiveContainer, XAxis, Tooltip } from 'recharts'
import { calcFocusStats, formatMinutes } from '@/lib/focus-stats'
import { registerWidget, type WidgetProps } from './registry'

function FocusHours({ entities, trackers }: WidgetProps) {
  const titleMap = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of entities) m.set(e.id, e.title)
    return m
  }, [entities])

  const stats = useMemo(() => calcFocusStats(trackers, titleMap), [trackers, titleMap])

  if (stats.todayMinutes === 0 && stats.thisWeekMinutes === 0)
    return <p className="text-xs text-muted-foreground">No focus sessions yet</p>

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <Brain className="size-4 text-primary" />
          <span className="text-lg font-semibold">{formatMinutes(stats.todayMinutes)}</span>
        </div>
        <span className="text-xs text-muted-foreground">
          {stats.todaySessions} session{stats.todaySessions !== 1 ? 's' : ''}
        </span>
      </div>
      <ResponsiveContainer width="100%" height={48}>
        <BarChart data={stats.weekDays}>
          <XAxis dataKey="label" tick={{ fontSize: 10 }} axisLine={false} tickLine={false} />
          <Tooltip
            formatter={(v) => formatMinutes(Number(v))}
            labelFormatter={(l) => String(l)}
          />
          <Bar dataKey="minutes" fill="hsl(var(--primary))" radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

registerWidget(
  {
    id: 'focus-hours',
    name: 'Focus Stats',
    relevance: ({ trackers }) => {
      const hasFocus = trackers.some((t) => t.unit === 'focus-min')
      return hasFocus ? 2 : null
    },
  },
  FocusHours,
)
