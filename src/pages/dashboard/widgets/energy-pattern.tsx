import { Zap } from 'lucide-react'
import { registerWidget, type WidgetProps } from './registry'

function avg(nums: number[]): number {
  return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : 0
}

function EnergyBar({ label, value, max }: { label: string; value: number; max: number }) {
  const pct = max > 0 ? (value / max) * 100 : 0
  const color =
    value >= 7 ? 'bg-emerald-500' : value >= 4 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span>{value.toFixed(1)}</span>
      </div>
      <div className="h-2 w-full rounded-full bg-muted">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function EnergyPattern({ trackers }: WidgetProps) {
  const energyTrackers = trackers.filter((t) => t.unit === 'energy')

  const morning = energyTrackers.filter((t) => t.note === 'morning').map((t) => t.value)
  const afternoon = energyTrackers.filter((t) => t.note === 'afternoon').map((t) => t.value)

  const morningAvg = avg(morning)
  const afternoonAvg = avg(afternoon)

  if (morning.length === 0 && afternoon.length === 0)
    return <p className="text-xs text-muted-foreground">No energy data</p>

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Zap className="size-3" />
        <span>Energy Levels</span>
      </div>
      <EnergyBar label="Morning" value={morningAvg} max={10} />
      <EnergyBar label="Afternoon" value={afternoonAvg} max={10} />
    </div>
  )
}

registerWidget(
  {
    id: 'energy-pattern',
    name: 'Energy Pattern',
    relevance: ({ trackers }) => {
      const hasEnergy = trackers.some((t) => t.unit === 'energy')
      return hasEnergy ? 2 : null
    },
  },
  EnergyPattern,
)
