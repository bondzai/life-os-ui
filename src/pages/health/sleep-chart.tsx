import { useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Entity } from '@/core/types'

interface SleepChartProps {
  entries: Entity[]
}

export function SleepChart({ entries }: SleepChartProps) {
  const data = useMemo(() => {
    const thirtyDaysAgo = new Date()
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30)
    const cutoff = thirtyDaysAgo.toISOString().split('T')[0]

    return entries
      .filter(
        (e) =>
          e.metadata.sleepHours != null &&
          ((e.metadata.date as string) || '') >= cutoff,
      )
      .sort((a, b) => ((a.metadata.date as string) || '').localeCompare((b.metadata.date as string) || ''))
      .map((e) => ({
        date: (e.metadata.date as string) || '',
        hours: e.metadata.sleepHours as number,
      }))
  }, [entries])

  if (data.length < 2) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">Sleep Trend (30 Days)</CardTitle>
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
              domain={[0, 12]}
              tick={{ fontSize: 11 }}
              tickFormatter={(v) => `${v}h`}
            />
            <Tooltip
              formatter={(value: number | undefined) => [`${value ?? 0}h`, 'Sleep']}
              labelFormatter={(label) => {
                const d = new Date(label + 'T00:00:00')
                return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
              }}
            />
            <ReferenceLine y={8} stroke="#22c55e" strokeDasharray="3 3" label={{ value: '8h', fontSize: 10, fill: '#22c55e' }} />
            <Line
              type="monotone"
              dataKey="hours"
              stroke="#8b5cf6"
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
