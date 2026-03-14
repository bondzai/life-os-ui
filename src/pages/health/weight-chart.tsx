import { useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Entity } from '@/core/types'

interface WeightChartProps {
  metrics: Entity[]
}

export function WeightChart({ metrics }: WeightChartProps) {
  const data = useMemo(() => {
    return metrics
      .filter((m) => m.metadata.metricType === 'weight' && m.metadata.value != null)
      .sort((a, b) => ((a.metadata.date as string) || '').localeCompare((b.metadata.date as string) || ''))
      .map((m) => ({
        date: (m.metadata.date as string) || '',
        weight: m.metadata.value as number,
      }))
  }, [metrics])

  if (data.length < 2) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Weight Trend</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={300}>
          <LineChart data={data} margin={{ left: 10, right: 10 }}>
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11 }}
              tickFormatter={(d) => {
                const parts = d.split('-')
                return `${parts[1]}/${parts[2]}`
              }}
            />
            <YAxis
              domain={['dataMin - 1', 'dataMax + 1']}
              tick={{ fontSize: 11 }}
              tickFormatter={(v) => `${v} kg`}
            />
            <Tooltip
              formatter={(value: number | undefined) => [`${value ?? 0} kg`, 'Weight']}
              labelFormatter={(label) => {
                const d = new Date(label + 'T00:00:00')
                return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
              }}
            />
            <Line
              type="monotone"
              dataKey="weight"
              stroke="#3b82f6"
              strokeWidth={2}
              dot={{ r: 3 }}
              activeDot={{ r: 5 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
