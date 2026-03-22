import type { Entity } from '@/core/types'
import type { Tracker } from '@/core/types/tracker'

export function buildHabitContext(habit: Entity, trackers: Tracker[]): string {
  const lines: string[] = [`Habit: "${habit.title}"`]

  if (habit.description) lines.push(`Description: ${habit.description}`)

  const streak = typeof habit.metadata?.streak === 'number' ? habit.metadata.streak : 0
  const frequency = (habit.metadata?.frequency as string) ?? 'daily'
  lines.push(`Streak: ${streak} days`)
  lines.push(`Frequency: ${frequency}`)

  // Last 30 days of check-ins
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
  const recentCheckins = trackers.filter(
    (t) => t.entityId === habit.id && t.timestamp >= thirtyDaysAgo,
  )
  lines.push(`Check-ins (last 30d): ${recentCheckins.length}`)

  // Weekly pattern
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const dayCounts = new Array(7).fill(0)
  recentCheckins.forEach((t) => {
    const day = new Date(t.timestamp).getDay()
    dayCounts[day]++
  })
  const pattern = dayNames.map((d, i) => `${d}:${dayCounts[i]}`).join(' ')
  lines.push(`Weekly pattern: ${pattern}`)

  // Completion rate
  const rate = Math.round((recentCheckins.length / 30) * 100)
  lines.push(`30-day rate: ${rate}%`)

  return lines.join('\n')
}
