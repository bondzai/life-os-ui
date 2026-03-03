import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { formatTHB } from './wealth-helpers'

interface AllocationChartProps {
  data: Array<{ name: string; value: number }>
}

const COLORS = [
  '#f59e0b', '#8b5cf6', '#3b82f6', '#22c55e',
  '#ef4444', '#06b6d4', '#ec4899', '#64748b',
]

export function AllocationChart({ data }: AllocationChartProps) {
  if (data.length === 0) return null

  const total = data.reduce((sum, d) => sum + d.value, 0)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Portfolio Allocation</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={260}>
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={60}
              outerRadius={100}
              paddingAngle={2}
              dataKey="value"
              nameKey="name"
              label={({ name, percent }) => `${name} ${((percent ?? 0) * 100).toFixed(0)}%`}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(value) => formatTHB(Number(value))} />
          </PieChart>
        </ResponsiveContainer>
        <p className="text-center text-sm text-muted-foreground mt-2">
          Total: <span className="font-semibold text-foreground">{formatTHB(total)}</span>
        </p>
      </CardContent>
    </Card>
  )
}
