import { Moon } from 'lucide-react'
import { registerWidget, type WidgetProps } from './registry'

function SleepTrend({ entities }: WidgetProps) {
  const sleepEntries = entities
    .filter((e) => e.type === 'sleep-mood' && typeof e.metadata.sleepHours === 'number')
    .sort((a, b) => {
      const da = (a.metadata.date as string) || a.createdAt
      const db = (b.metadata.date as string) || b.createdAt
      return db.localeCompare(da)
    })
    .slice(0, 7)
    .reverse()

  if (sleepEntries.length === 0)
    return <p className="text-xs text-muted-foreground">No sleep data</p>

  const avg =
    sleepEntries.reduce((s, e) => s + (e.metadata.sleepHours as number), 0) /
    sleepEntries.length
  const maxHours = Math.max(...sleepEntries.map((e) => e.metadata.sleepHours as number), 10)

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1 text-muted-foreground">
          <Moon className="size-3" />
          <span>Last 7 entries</span>
        </div>
        <span className={avg < 6 ? 'text-red-500 font-medium' : 'text-muted-foreground'}>
          Avg: {avg.toFixed(1)}h
        </span>
      </div>
      <div className="flex items-end gap-1 h-10">
        {sleepEntries.map((e) => {
          const hours = e.metadata.sleepHours as number
          const h = Math.max((hours / maxHours) * 100, 8)
          return (
            <div key={e.id} className="flex-1 flex flex-col items-center gap-0.5">
              <div
                className={`w-full rounded-sm ${hours < 6 ? 'bg-red-500' : hours < 7 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                style={{ height: `${h}%` }}
              />
              <span className="text-[10px] text-muted-foreground">{hours.toFixed(0)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}

registerWidget(
  {
    id: 'sleep-trend',
    name: 'Sleep Trend',
    relevance: ({ entities }) => {
      const sleepEntries = entities.filter(
        (e) => e.type === 'sleep-mood' && typeof e.metadata.sleepHours === 'number',
      )
      if (sleepEntries.length === 0) return null
      const avg =
        sleepEntries.reduce((s, e) => s + (e.metadata.sleepHours as number), 0) /
        sleepEntries.length
      return avg < 6 ? 3 : 2
    },
  },
  SleepTrend,
)
