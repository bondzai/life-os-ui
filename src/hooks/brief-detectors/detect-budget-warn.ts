import type { Detector, Insight } from './types'

export const detectBudgetWarn: Detector = ({ entities, today }) => {
  const insights: Insight[] = []

  const budgets = entities.filter((e) => e.type === 'budget' && e.status !== 'archived')
  if (budgets.length === 0) return insights

  // Current month transactions
  const monthStart = today.slice(0, 7) + '-01'
  const transactions = entities.filter(
    (e) =>
      e.type === 'transaction' &&
      e.metadata.txType === 'expense' &&
      ((e.metadata.date as string) || '') >= monthStart,
  )

  // Spent by category
  const spentByCategory: Record<string, number> = {}
  for (const tx of transactions) {
    const cat = (tx.metadata.category as string) || 'other'
    spentByCategory[cat] = (spentByCategory[cat] || 0) + ((tx.metadata.amount as number) || 0)
  }

  // Days remaining in month
  const todayDate = new Date(today)
  const daysInMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 0).getDate()
  const daysRemaining = daysInMonth - todayDate.getDate()

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
        title: `"${budget.title}" budget at ${pct}% (${daysRemaining}d left)`,
        actionLabel: 'View',
        actionPath: '/wealth',
        data: { budgetId: budget.id, pct, spent, limit, daysRemaining, category: cat },
      })
    }
  }

  return insights
}
