import { Scale } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { registerWidget, type WidgetProps } from './registry'

function DecisionReview({ entities }: WidgetProps) {
  const today = new Date().toISOString().split('T')[0]

  const decisions = entities.filter(
    (e) =>
      e.type === 'note' &&
      e.metadata.isDecision === true &&
      e.metadata.revisitStatus === 'pending' &&
      typeof e.metadata.revisitDate === 'string' &&
      (e.metadata.revisitDate as string) <= today,
  )

  if (decisions.length === 0)
    return <p className="text-xs text-muted-foreground">No decisions due for review</p>

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Scale className="size-3" />
        <span>{decisions.length} decision{decisions.length !== 1 ? 's' : ''} to review</span>
      </div>
      {decisions.slice(0, 5).map((d) => (
        <div key={d.id} className="flex items-center justify-between gap-2">
          <span className="text-sm truncate">{d.title}</span>
          <Badge variant="outline" className="text-xs shrink-0">
            {d.metadata.revisitDate as string}
          </Badge>
        </div>
      ))}
    </div>
  )
}

registerWidget(
  {
    id: 'decision-review',
    name: 'Decisions Due for Review',
    relevance: ({ entities, today }) => {
      const hasDue = entities.some(
        (e) =>
          e.type === 'note' &&
          e.metadata.isDecision === true &&
          e.metadata.revisitStatus === 'pending' &&
          typeof e.metadata.revisitDate === 'string' &&
          (e.metadata.revisitDate as string) <= today,
      )
      return hasDue ? 2 : null
    },
  },
  DecisionReview,
)
