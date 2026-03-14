import { useMemo, useEffect } from 'react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { TrendingUp } from 'lucide-react'

interface NetWorthChartProps {
  currentNetWorth: number
}

const STORAGE_KEY = 'life-os:net-worth-snapshots'

interface Snapshot {
  month: string // YYYY-MM
  value: number
}

function getSnapshots(): Snapshot[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function saveSnapshots(snapshots: Snapshot[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshots))
}

export function NetWorthChart({ currentNetWorth }: NetWorthChartProps) {
  const currentMonth = new Date().toISOString().slice(0, 7) // YYYY-MM

  // Auto-snapshot current month on load if missing
  useEffect(() => {
    const snapshots = getSnapshots()
    const existing = snapshots.find((s) => s.month === currentMonth)
    if (!existing) {
      snapshots.push({ month: currentMonth, value: currentNetWorth })
      saveSnapshots(snapshots)
    } else {
      // Update current month's value
      existing.value = currentNetWorth
      saveSnapshots(snapshots)
    }
  }, [currentMonth, currentNetWorth])

  const data = useMemo(() => {
    const snapshots = getSnapshots()
    return snapshots
      .sort((a, b) => a.month.localeCompare(b.month))
      .map((s) => ({
        month: s.month.slice(5), // MM only for display
        value: s.value,
      }))
  }, [currentNetWorth]) // eslint-disable-line react-hooks/exhaustive-deps

  if (data.length < 2) {
    return (
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <TrendingUp className="h-4 w-4 text-muted-foreground" />
            Net Worth Trend
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            Not enough data yet. The chart will appear after 2+ months of tracking.
          </p>
        </CardContent>
      </Card>
    )
  }

  const formatTHB = (v: number) => `฿${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <TrendingUp className="h-4 w-4 text-muted-foreground" />
          Net Worth Trend
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={200}>
          <LineChart data={data}>
            <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} tickFormatter={formatTHB} width={80} />
            <Tooltip formatter={(v: number | undefined) => [formatTHB(v ?? 0), 'Net Worth']} />
            <Line
              type="monotone"
              dataKey="value"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={{ r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  )
}
