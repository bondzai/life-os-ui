import { useMemo } from 'react'
import { Crosshair, Star, AlertTriangle, Crown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useWeeklyPlan } from '@/hooks/use-weekly-plan'
import { useMorningBrief } from '@/hooks/use-morning-brief'
import type { Entity } from '@/core/types'

interface DailyProtocolProps {
  entities: Entity[]
  onConfirm: (entityIds: string[]) => void
}

const PRIORITY_DOT: Record<string, string> = {
  urgent: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-blue-500',
  low: 'bg-zinc-500',
}

export function DailyProtocol({ entities, onConfirm }: DailyProtocolProps) {
  const { plan, todayAllocations } = useWeeklyPlan()
  const insights = useMorningBrief()

  const allocatedEntities = useMemo(
    () => todayAllocations
      .map((id) => entities.find((e) => e.id === id))
      .filter(Boolean) as Entity[],
    [todayAllocations, entities],
  )

  const activeOutcome = useMemo(() => {
    if (!plan) return null
    return plan.outcomes.find((o) => o.status === 'open') ?? null
  }, [plan])

  const signals = useMemo(
    () => insights.filter((i) => i.severity >= 2).slice(0, 3),
    [insights],
  )

  // Don't render if no weekly plan or no allocations for today
  if (!plan || allocatedEntities.length === 0) return null

  return (
    <div className="rounded-lg border bg-card/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 flex items-center gap-1.5">
          <Crosshair className="h-3 w-3 text-primary" />
          Today&apos;s Protocol
        </h3>
        {plan.locked && (
          <Badge variant="outline" className="text-[9px] px-1.5 py-0">from weekly plan</Badge>
        )}
      </div>

      {/* Weekly star reminder */}
      {activeOutcome && (
        <p className="text-xs text-amber-500/70 flex items-center gap-1.5">
          <Star className="h-3 w-3 shrink-0" />
          {activeOutcome.text}
        </p>
      )}

      {/* Allocated tasks */}
      <div className="space-y-1">
        {allocatedEntities.map((entity) => (
          <div key={entity.id} className="flex items-center gap-2 py-1">
            <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_DOT[entity.priority] ?? PRIORITY_DOT.medium}`} />
            <span className="text-sm flex-1 truncate">{entity.title}</span>
            {entity.dueDate && (
              <span className="text-[10px] text-muted-foreground/40 shrink-0">
                due {new Date(entity.dueDate).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </span>
            )}
          </div>
        ))}
      </div>

      {/* Signals */}
      {signals.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-border/30">
          {signals.map((s) => (
            <p key={s.id} className="text-[11px] text-amber-500/60 flex items-center gap-1.5">
              <AlertTriangle className="h-3 w-3 shrink-0" />
              {s.title}
            </p>
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2 pt-1">
        <Button
          size="sm"
          className="gap-1.5 flex-1"
          onClick={() => onConfirm(todayAllocations)}
        >
          <Crown className="h-3 w-3" />
          Confirm & Focus
        </Button>
      </div>
    </div>
  )
}
