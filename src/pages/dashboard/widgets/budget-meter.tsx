import { DollarSign } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { registerWidget, type WidgetProps } from './registry'

function BudgetMeter({ entities }: WidgetProps) {
  const now = new Date()
  const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`

  const budgets = entities.filter(
    (e) => e.type === 'budget' && e.status !== 'archived',
  )
  const transactions = entities.filter(
    (e) =>
      e.type === 'transaction' &&
      (e.metadata.txType as string) === 'expense' &&
      typeof e.metadata.date === 'string' &&
      (e.metadata.date as string).startsWith(monthPrefix),
  )

  const budgetData = budgets.map((b) => {
    const limit = Number(b.metadata.amount) || 0
    const category = b.metadata.category as string
    const spent = transactions
      .filter((t) => (t.metadata.category as string) === category)
      .reduce((s, t) => s + (Number(t.metadata.amount) || 0), 0)
    const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0
    return { budget: b, limit, spent, pct, category }
  })

  if (budgetData.length === 0)
    return <p className="text-xs text-muted-foreground">No budgets set</p>

  return (
    <div className="space-y-2.5">
      {budgetData.slice(0, 5).map(({ budget, spent, limit, pct }) => (
        <div key={budget.id} className="space-y-1">
          <div className="flex items-center justify-between text-sm">
            <span className="truncate">{budget.title}</span>
            <span className={`text-xs shrink-0 ${pct > 80 ? 'text-red-500' : pct > 60 ? 'text-amber-500' : 'text-muted-foreground'}`}>
              <DollarSign className="size-3 inline" />
              {spent.toFixed(0)} / {limit.toFixed(0)}
            </span>
          </div>
          <Progress
            value={Math.min(pct, 100)}
            className={`h-1.5 ${pct > 80 ? '[&>[data-slot=progress-indicator]]:bg-red-500' : pct > 60 ? '[&>[data-slot=progress-indicator]]:bg-amber-500' : ''}`}
          />
        </div>
      ))}
    </div>
  )
}

registerWidget(
  {
    id: 'budget-meter',
    name: 'Budget Status',
    relevance: ({ entities }) => {
      const now = new Date()
      const monthPrefix = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
      const budgets = entities.filter(
        (e) => e.type === 'budget' && e.status !== 'archived',
      )
      if (budgets.length === 0) return null
      const transactions = entities.filter(
        (e) =>
          e.type === 'transaction' &&
          (e.metadata.txType as string) === 'expense' &&
          typeof e.metadata.date === 'string' &&
          (e.metadata.date as string).startsWith(monthPrefix),
      )
      const anyOver80 = budgets.some((b) => {
        const limit = Number(b.metadata.amount) || 0
        if (limit === 0) return false
        const category = b.metadata.category as string
        const spent = transactions
          .filter((t) => (t.metadata.category as string) === category)
          .reduce((s, t) => s + (Number(t.metadata.amount) || 0), 0)
        return spent / limit > 0.8
      })
      return anyOver80 ? 3 : 2
    },
  },
  BudgetMeter,
)
