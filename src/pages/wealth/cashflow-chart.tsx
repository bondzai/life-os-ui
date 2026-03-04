import { useMemo } from 'react'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Entity } from '@/core/types'

interface CashflowChartProps {
  transactions: Entity[]
}

function getLast6Months(): string[] {
  const months: string[] = []
  const now = new Date()
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    months.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`)
  }
  return months
}

function formatMonthLabel(ym: string): string {
  const [y, m] = ym.split('-')
  const d = new Date(Number(y), Number(m) - 1)
  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
}

export function CashflowChart({ transactions }: CashflowChartProps) {
  const data = useMemo(() => {
    const months = getLast6Months()
    const byMonth: Record<string, { income: number; expense: number }> = {}
    for (const m of months) byMonth[m] = { income: 0, expense: 0 }

    for (const tx of transactions) {
      const date = (tx.metadata.date as string) || tx.dueDate || ''
      const ym = date.slice(0, 7)
      if (!byMonth[ym]) continue
      const amount = (tx.metadata.amount as number) || 0
      if (tx.metadata.txType === 'income') byMonth[ym].income += amount
      else if (tx.metadata.txType === 'expense') byMonth[ym].expense += amount
    }

    return months.map((m) => ({
      month: formatMonthLabel(m),
      income: byMonth[m].income,
      expense: byMonth[m].expense,
    }))
  }, [transactions])

  const hasData = data.some((d) => d.income > 0 || d.expense > 0)
  if (!hasData) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Income vs Expense (6 Months)</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={data} margin={{ left: 10, right: 10 }}>
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis tickFormatter={(v) => `฿${(v / 1000).toFixed(0)}k`} tick={{ fontSize: 12 }} />
            <Tooltip formatter={(value) => `฿${Number(value).toLocaleString()}`} />
            <Legend />
            <Bar dataKey="income" name="Income" fill="#22c55e" radius={[4, 4, 0, 0]} />
            <Bar dataKey="expense" name="Expense" fill="#ef4444" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
