import { useVelocity } from '@/hooks/use-velocity'
import { Badge } from '@/components/ui/badge'

interface VelocityPanelProps {
  entityId: string
  entityType: 'goal' | 'project'
  dueDate?: string
}

const riskColors: Record<string, string> = {
  'on-track': 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  'at-risk': 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  'will-miss': 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
}

const riskLabels: Record<string, string> = {
  'on-track': 'On Track',
  'at-risk': 'At Risk',
  'will-miss': 'Will Miss',
}

export function VelocityPanel({ entityId, entityType, dueDate }: VelocityPanelProps) {
  const velocity = useVelocity(entityId, entityType, dueDate)

  if (velocity.totalTasks === 0) return null

  const maxVelocity = Math.max(...velocity.weeklyVelocity, 1)

  return (
    <div className="space-y-2 rounded-lg border p-3">
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        Velocity
      </h4>

      {/* Velocity bar — 4 mini bars */}
      <div className="flex items-end gap-1 h-8">
        {velocity.weeklyVelocity.map((v, i) => (
          <div key={i} className="flex-1 flex flex-col items-center gap-0.5">
            <div
              className="w-full rounded-sm bg-primary/70 transition-all"
              style={{
                height: `${Math.max((v / maxVelocity) * 100, 4)}%`,
                minHeight: v > 0 ? '4px' : '2px',
                opacity: v > 0 ? 1 : 0.2,
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between text-[10px] text-muted-foreground/60">
        <span>4w ago</span>
        <span>This week</span>
      </div>

      {/* Stats row */}
      <p className="text-sm text-muted-foreground">
        {velocity.completedTasks}/{velocity.totalTasks} tasks done{' '}
        <span className="mx-1">&middot;</span>{' '}
        {velocity.avgVelocity.toFixed(1)}/week avg
      </p>

      {/* Projection */}
      <p className="text-sm">
        {velocity.projectedDate ? (
          <>
            Projected completion:{' '}
            <span className="font-medium">
              {new Date(velocity.projectedDate).toLocaleDateString()}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground">&infin; &mdash; no velocity</span>
        )}
      </p>

      {/* Risk indicator — only if entity has a dueDate */}
      {dueDate && (
        <Badge variant="outline" className={`text-xs ${riskColors[velocity.riskLevel]}`}>
          {riskLabels[velocity.riskLevel]}
        </Badge>
      )}
    </div>
  )
}
