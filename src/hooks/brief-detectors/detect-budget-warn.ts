import type { Detector, Insight } from './types'
import { getMonthlySpending } from './utils'

export const detectBudgetWarn: Detector = ({ entities, today }) => {
  const insights: Insight[] = []

  const budgets = entities.filter((e) => e.type === 'budget' && e.status !== 'archived')
  if (budgets.length === 0) return insights

  const { spentByCategory, daysLeft } = getMonthlySpending(entities, today)

  for (const budget of budgets) {
    const limit = (budget.metadata.amount as number) || 0
    const cat = (budget.metadata.category as string) || ''
    const spent = spentByCategory[cat] || 0
    const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0

    if (pct >= 80) {
      insights.push({
        id: `budget-warn-${budget.id}`,
        type: 'warning',
        category: 'wealth',
        severity: pct >= 100 ? 3 : 2,
        title: `"${budget.title}" budget at ${pct}% (${daysLeft}d left)`,
        actionLabel: 'View',
        actionPath: '/wealth',
        data: { budgetId: budget.id, pct, spent, limit, daysRemaining: daysLeft, category: cat },
      })
    }
  }

  return insights
}
