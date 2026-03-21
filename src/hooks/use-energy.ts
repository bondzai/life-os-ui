import { useMemo } from 'react'
import { useTrackers } from '@/core/hooks'

interface EnergyDay {
  date: string
  morning: number | null
  afternoon: number | null
}

interface EnergyData {
  todayMorning: number | null
  todayAfternoon: number | null
  avgMorning: number
  avgAfternoon: number
  peakTime: 'morning' | 'afternoon' | null
  history: EnergyDay[]
}

export function useEnergy(): EnergyData {
  const { items: allTrackers } = useTrackers()

  return useMemo(() => {
    const energyTrackers = allTrackers.filter((t) => t.unit === 'energy')

    const now = new Date()
    const todayStr = now.toISOString().slice(0, 10)

    // Build a 14-day window
    const cutoff = new Date(now)
    cutoff.setDate(cutoff.getDate() - 14)

    const recentTrackers = energyTrackers.filter(
      (t) => new Date(t.timestamp) >= cutoff,
    )

    // Group by date
    const byDate = new Map<string, { morning: number | null; afternoon: number | null }>()

    for (const t of recentTrackers) {
      const dateStr = new Date(t.timestamp).toISOString().slice(0, 10)
      if (!byDate.has(dateStr)) {
        byDate.set(dateStr, { morning: null, afternoon: null })
      }
      const entry = byDate.get(dateStr)!
      if (t.note === 'morning') {
        entry.morning = t.value
      } else if (t.note === 'afternoon') {
        entry.afternoon = t.value
      }
    }

    // Today's values
    const todayEntry = byDate.get(todayStr)
    const todayMorning = todayEntry?.morning ?? null
    const todayAfternoon = todayEntry?.afternoon ?? null

    // Averages over the window
    let morningSum = 0
    let morningCount = 0
    let afternoonSum = 0
    let afternoonCount = 0

    for (const entry of byDate.values()) {
      if (entry.morning !== null) {
        morningSum += entry.morning
        morningCount++
      }
      if (entry.afternoon !== null) {
        afternoonSum += entry.afternoon
        afternoonCount++
      }
    }

    const avgMorning = morningCount > 0 ? morningSum / morningCount : 0
    const avgAfternoon = afternoonCount > 0 ? afternoonSum / afternoonCount : 0

    let peakTime: 'morning' | 'afternoon' | null = null
    if (morningCount > 0 || afternoonCount > 0) {
      if (avgMorning > avgAfternoon) peakTime = 'morning'
      else if (avgAfternoon > avgMorning) peakTime = 'afternoon'
    }

    // Build history array (last 14 days)
    const history: EnergyDay[] = []
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(d.getDate() - i)
      const ds = d.toISOString().slice(0, 10)
      const entry = byDate.get(ds)
      history.push({
        date: ds,
        morning: entry?.morning ?? null,
        afternoon: entry?.afternoon ?? null,
      })
    }

    return {
      todayMorning,
      todayAfternoon,
      avgMorning,
      avgAfternoon,
      peakTime,
      history,
    }
  }, [allTrackers])
}
