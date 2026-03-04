import { Wallet } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Entity } from '@/core/types'

interface StepSpendingProps {
  transactions: Entity[]
  budgetTotal: number
}

function formatTHB(amount: number): string {
  return amount.toLocaleString('th-TH', { style: 'currency', currency: 'THB', maximumFractionDigits: 0 })
}

export function StepSpending({ transactions, budgetTotal }: StepSpendingProps) {
  const expenses = transactions.filter((t) => t.metadata.txType === 'expense')
  const totalSpent = expenses.reduce((sum, t) => sum + (Number(t.metadata.amount) || 0), 0)
  const income = transactions.filter((t) => t.metadata.txType === 'income')
  const totalIncome = income.reduce((sum, t) => sum + (Number(t.metadata.amount) || 0), 0)

  const spentPercent = budgetTotal > 0 ? Math.round((totalSpent / budgetTotal) * 100) : 0

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Wallet className="h-4 w-4 text-muted-foreground" />
          This week's spending
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <p className="text-xs text-muted-foreground">Income</p>
            <p className="text-lg font-semibold text-green-600">{formatTHB(totalIncome)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">Expenses</p>
            <p className="text-lg font-semibold text-red-600">{formatTHB(totalSpent)}</p>
          </div>
        </div>
        {budgetTotal > 0 && (
          <div className="text-sm text-muted-foreground">
            <span className={spentPercent > 100 ? 'text-red-600 font-medium' : ''}>
              {spentPercent}%
            </span>
            {' '}of monthly budget used ({formatTHB(totalSpent)} / {formatTHB(budgetTotal)})
          </div>
        )}
        {expenses.length === 0 && income.length === 0 && (
          <p className="text-sm text-muted-foreground">No transactions this week.</p>
        )}
      </CardContent>
    </Card>
  )
}
