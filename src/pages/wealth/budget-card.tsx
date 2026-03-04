import { Pencil, Trash2, AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { formatTHB } from './wealth-helpers'
import type { Entity } from '@/core/types'

interface BudgetCardProps {
  budget: Entity
  spent: number
  onEdit: (budget: Entity) => void
  onDelete: (budget: Entity) => void
}

export function BudgetCard({ budget, spent, onEdit, onDelete }: BudgetCardProps) {
  const budgeted = budget.metadata.amount as number
  const pct = budgeted > 0 ? Math.round((spent / budgeted) * 100) : 0
  const barColor =
    pct > 100
      ? 'bg-red-500'
      : pct >= 75
        ? 'bg-yellow-500'
        : 'bg-green-500'

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <CardTitle className="text-sm font-medium capitalize">
              {budget.metadata.category as string}
            </CardTitle>
            {pct >= 80 && (
              <Badge variant="destructive" className="text-[10px] px-1.5 py-0 h-4 gap-0.5">
                <AlertTriangle className="h-2.5 w-2.5" />
                {pct >= 100 ? 'Over' : `${pct}%`}
              </Badge>
            )}
          </div>
          <div className="flex gap-1 shrink-0">
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onEdit(budget)}>
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onDelete(budget)}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">
            {formatTHB(spent)} / {formatTHB(budgeted)}
          </span>
          <span className="font-medium">{pct}%</span>
        </div>
        <div className="bg-primary/20 relative h-2 w-full overflow-hidden rounded-full">
          <div
            className={`h-full transition-all ${barColor}`}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
      </CardContent>
    </Card>
  )
}
