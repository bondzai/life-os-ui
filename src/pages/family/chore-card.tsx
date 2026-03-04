import { Pencil, Trash2, CalendarDays, RotateCcw, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  CATEGORY_COLORS,
  FREQUENCY_LABELS,
  ASSIGNEES,
  type ChoreCategory,
  type ChoreFrequency,
} from './family-helpers'
import type { Entity } from '@/core/types'

interface ChoreCardProps {
  chore: Entity
  onEdit: (chore: Entity) => void
  onDelete: (chore: Entity) => void
  onComplete: (chore: Entity) => void
}

export function ChoreCard({ chore, onEdit, onDelete, onComplete }: ChoreCardProps) {
  const category = chore.metadata.category as ChoreCategory
  const frequency = chore.metadata.frequency as ChoreFrequency
  const assigneeId = chore.metadata.assigneeId as string
  const note = chore.metadata.note as string | undefined
  const dueDate = chore.dueDate

  const assigneeName = ASSIGNEES.find((a) => a.id === assigneeId)?.name ?? assigneeId
  const categoryLabel = category.charAt(0).toUpperCase() + category.slice(1)
  const isOverdue = dueDate && new Date(dueDate) < new Date(new Date().toISOString().split('T')[0])

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-medium">{chore.title}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">Assigned to {assigneeName}</p>
          </div>
          <div className="flex gap-1 shrink-0">
            <Badge className={`text-xs ${CATEGORY_COLORS[category] || ''}`}>
              {categoryLabel}
            </Badge>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-4 text-sm text-muted-foreground">
          <span className="flex items-center gap-1">
            <RotateCcw className="h-3.5 w-3.5" />
            {FREQUENCY_LABELS[frequency]}
          </span>
          {dueDate && (
            <span className={`flex items-center gap-1 ${isOverdue ? 'text-red-500 font-medium' : ''}`}>
              <CalendarDays className="h-3.5 w-3.5" />
              {new Date(dueDate).toLocaleDateString()}
            </span>
          )}
        </div>
        {note && (
          <p className="text-xs text-muted-foreground italic">{note}</p>
        )}
        <div className="flex gap-1">
          <Button size="sm" variant="outline" className="h-7 px-2" onClick={() => onComplete(chore)}>
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onEdit(chore)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onDelete(chore)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
        {Array.isArray(chore.metadata.completions) && (chore.metadata.completions as Array<{date: string; completedBy: string}>).length > 0 && (
          <div className="space-y-0.5">
            <p className="text-[10px] text-muted-foreground font-medium">Recent completions:</p>
            {(chore.metadata.completions as Array<{date: string; completedBy: string}>).slice(-3).reverse().map((c, i) => {
              const name = ASSIGNEES.find(a => a.id === c.completedBy)?.name ?? c.completedBy
              return (
                <p key={i} className="text-[10px] text-muted-foreground">
                  {c.date} — {name}
                </p>
              )
            })}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
