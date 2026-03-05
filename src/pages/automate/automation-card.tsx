import { Pencil, Trash2, Play, Clock, Zap, Eye } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  TRIGGER_LABELS,
  SCHEDULE_LABELS,
  ACTION_LABELS,
  ACTION_COLORS,
  type TriggerType,
  type ScheduleInterval,
  type ActionType,
} from './automate-helpers'
import type { Entity } from '@/core/types'

interface AutomationCardProps {
  automation: Entity
  onEdit: (automation: Entity) => void
  onDelete: (automation: Entity) => void
  onRun: (automation: Entity) => void
  onPreview?: (automation: Entity) => void
}

export function AutomationCard({ automation, onEdit, onDelete, onRun, onPreview }: AutomationCardProps) {
  const triggerType = automation.metadata.triggerType as TriggerType
  const scheduleInterval = automation.metadata.scheduleInterval as ScheduleInterval | undefined
  const actionType = automation.metadata.actionType as ActionType
  const lastRun = automation.metadata.lastRun as string | undefined
  const runCount = (automation.metadata.runCount as number) || 0
  const nextDue = automation.metadata.nextDue as string | undefined
  const isEnabled = automation.metadata.enabled !== false

  const triggerLabel =
    triggerType === 'schedule' && scheduleInterval
      ? `${TRIGGER_LABELS[triggerType]} — ${SCHEDULE_LABELS[scheduleInterval]}`
      : TRIGGER_LABELS[triggerType]

  return (
    <Card className={!isEnabled ? 'opacity-50' : ''}>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-medium">{automation.title}</CardTitle>
            {automation.description && (
              <p className="text-xs text-muted-foreground mt-0.5">{automation.description}</p>
            )}
          </div>
          <Badge className={`text-xs shrink-0 ${ACTION_COLORS[actionType] || ''}`}>
            {ACTION_LABELS[actionType]}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-4 text-sm text-muted-foreground flex-wrap">
          <span className="flex items-center gap-1">
            <Zap className="h-3.5 w-3.5" />
            {triggerLabel}
          </span>
          {nextDue && (
            <span className="flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" />
              Next: {new Date(nextDue).toLocaleDateString()}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>Runs: {runCount}</span>
          {lastRun && <span>Last: {new Date(lastRun).toLocaleString()}</span>}
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onRun(automation)}>
            <Play className="h-3.5 w-3.5" />
          </Button>
          {onPreview && (
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onPreview(automation)}>
              <Eye className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onEdit(automation)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onDelete(automation)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
