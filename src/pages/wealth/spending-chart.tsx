import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

interface SpendingChartProps {
  data: Array<{ category: string; amount: number }>
}

const COLORS = [
  '#ef4444', '#f97316', '#eab308', '#22c55e',
  '#06b6d4', '#3b82f6', '#8b5cf6', '#ec4899',
]

export function SpendingChart({ data }: SpendingChartProps) {
  if (data.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Spending by Category (This Month)</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={Math.max(data.length * 40, 120)}>
          <BarChart data={data} layout="vertical" margin={{ left: 20, right: 20 }}>
            <XAxis type="number" tickFormatter={(v) => `฿${v.toLocaleString()}`} />
            <YAxis
              type="category"
              dataKey="category"
              width={100}
              tick={{ fontSize: 12 }}
              className="capitalize"
            />
            <Tooltip formatter={(value) => `฿${Number(value).toLocaleString()}`} />
            <Bar dataKey="amount" radius={[0, 4, 4, 0]}>
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
