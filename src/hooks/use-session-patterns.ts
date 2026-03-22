import { useMemo } from 'react'
import { useTrackers } from '@/core/hooks'

export function useSessionPatterns() {
  const { items: trackers } = useTrackers()

  return useMemo(() => {
    const quality = trackers.filter((t) => t.unit === 'session-quality')
    if (quality.length < 3) return null

    // Average quality
    const avgQuality = quality.reduce((s, t) => s + t.value, 0) / quality.length

    // By time of day
    const byTime: Record<string, { total: number; count: number }> = {
      morning: { total: 0, count: 0 },
      afternoon: { total: 0, count: 0 },
      evening: { total: 0, count: 0 },
    }
    for (const t of quality) {
      const h = new Date(t.timestamp).getHours()
      const slot = h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening'
      byTime[slot].total += t.value
      byTime[slot].count++
    }

    const bestTimeOfDay =
      Object.entries(byTime)
        .filter(([, v]) => v.count >= 2)
        .sort(([, a], [, b]) => b.total / b.count - a.total / a.count)[0]?.[0] ?? null

    // By day of week
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const byDay: Record<number, { total: number; count: number }> = {}
    for (const t of quality) {
      const day = new Date(t.timestamp).getDay()
      if (!byDay[day]) byDay[day] = { total: 0, count: 0 }
      byDay[day].total += t.value
      byDay[day].count++
    }
    const bestDayEntry = Object.entries(byDay)
      .filter(([, v]) => v.count >= 2)
      .sort(([, a], [, b]) => b.total / b.count - a.total / a.count)[0]
    const bestDayOfWeek = bestDayEntry ? dayNames[Number(bestDayEntry[0])] : null

    // Recent trend (last 5 vs previous 5)
    const sorted = [...quality].sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    const recent5 = sorted.slice(0, 5)
    const prev5 = sorted.slice(5, 10)
    const recentAvg = recent5.reduce((s, t) => s + t.value, 0) / recent5.length
    const prevAvg =
      prev5.length > 0 ? prev5.reduce((s, t) => s + t.value, 0) / prev5.length : recentAvg
    const recentTrend =
      recentAvg > prevAvg ? 'improving' : recentAvg < prevAvg ? 'declining' : 'stable'

    return {
      avgQuality: +avgQuality.toFixed(1),
      bestTimeOfDay,
      bestDayOfWeek,
      totalSessions: quality.length,
      recentTrend,
    }
  }, [trackers])
}
