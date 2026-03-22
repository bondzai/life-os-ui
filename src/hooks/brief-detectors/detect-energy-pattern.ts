import type { Detector, Insight } from './types'

export const detectEnergyPattern: Detector = ({ trackers }) => {
  const insights: Insight[] = []
  const energyTrackers = trackers.filter((t) => t.unit === 'energy')

  if (energyTrackers.length < 6) return insights // need at least 3 days of AM+PM

  const morning = energyTrackers.filter((t) => t.note === 'morning')
  const afternoon = energyTrackers.filter((t) => t.note === 'afternoon')

  if (morning.length === 0 || afternoon.length === 0) return insights

  const avgMorning = morning.reduce((s, t) => s + t.value, 0) / morning.length
  const avgAfternoon = afternoon.reduce((s, t) => s + t.value, 0) / afternoon.length

  const diff = Math.abs(avgMorning - avgAfternoon)
  if (diff < 0.5) return insights // not significant enough

  const peakTime = avgMorning > avgAfternoon ? 'morning' : 'afternoon'

  insights.push({
    id: 'energy-peak',
    type: 'suggestion',
    category: 'energy',
    severity: 1,
    title: `Energy peaks in the ${peakTime} (${avgMorning > avgAfternoon ? avgMorning.toFixed(1) : avgAfternoon.toFixed(1)}/5) — schedule deep work then`,
    data: { avgMorning: +avgMorning.toFixed(1), avgAfternoon: +avgAfternoon.toFixed(1), peakTime },
  })

  return insights
}
