import type { Detector, Insight } from './types'

const MS_PER_DAY = 86_400_000

export const detectThreats: Detector = ({ entities, trackers, today, now }) => {
  const insights: Insight[] = []

  // 1. Budget projection — spending rate × days remaining → when exceeded?
  const budgets = entities.filter(e => e.type === 'budget' && e.status !== 'archived')
  const monthStart = today.slice(0, 7) + '-01'
  const todayDate = new Date(today)
  const daysInMonth = new Date(todayDate.getFullYear(), todayDate.getMonth() + 1, 0).getDate()
  const daysPassed = todayDate.getDate()
  const daysLeft = daysInMonth - daysPassed

  for (const budget of budgets) {
    const limit = (budget.metadata?.amount as number) || 0
    if (limit <= 0) continue
    const cat = (budget.metadata?.category as string) || ''
    const spent = entities
      .filter(e => e.type === 'transaction' && e.metadata?.txType === 'expense' && e.metadata?.category === cat && ((e.metadata?.date as string) || '') >= monthStart)
      .reduce((sum, e) => sum + ((e.metadata?.amount as number) || 0), 0)

    if (daysPassed < 3 || spent === 0) continue
    const dailyRate = spent / daysPassed
    const projectedTotal = spent + dailyRate * daysLeft

    if (projectedTotal > limit) {
      const daysUntilExceed = Math.max(0, Math.floor((limit - spent) / dailyRate))
      insights.push({
        id: `threat-budget-${budget.id}`,
        type: 'risk',
        category: 'wealth',
        severity: daysUntilExceed <= 3 ? 3 : 2,
        title: `"${budget.title}" budget will exceed in ${daysUntilExceed} days at current rate`,
        detail: `Spent ${Math.round(spent)} of ${limit} (${Math.round(dailyRate)}/day)`,
        actionPath: '/wealth',
        actionLabel: 'View',
        data: { budgetId: budget.id, spent, limit, dailyRate, daysUntilExceed },
      })
    }
  }

  // 2. Streak break prediction — weekend pattern analysis
  const habits = entities.filter(e => e.type === 'habit' && e.status === 'todo')
  const dayOfWeek = new Date(now).getDay() // 0=Sun, 6=Sat
  const isFridayOrLater = dayOfWeek >= 5 || dayOfWeek === 0

  if (isFridayOrLater) {
    for (const habit of habits) {
      const streak = typeof habit.metadata?.streak === 'number' ? (habit.metadata.streak as number) : 0
      if (streak < 5) continue

      // Check last 4 weekends for check-in pattern
      const fourWeeksAgo = new Date(now - 28 * MS_PER_DAY)
      const recentTrackers = trackers.filter(t => t.entityId === habit.id && new Date(t.timestamp) >= fourWeeksAgo)
      const weekendCheckins = recentTrackers.filter(t => {
        const d = new Date(t.timestamp).getDay()
        return d === 0 || d === 6
      }).length
      const totalWeekends = 8 // 4 weekends × 2 days

      const weekendRate = weekendCheckins / totalWeekends
      if (weekendRate < 0.5) {
        insights.push({
          id: `threat-streak-${habit.id}`,
          type: 'risk',
          category: 'habits',
          severity: streak >= 20 ? 3 : 2,
          title: `"${habit.title}" ${streak}d streak — ${Math.round((1 - weekendRate) * 100)}% weekend break risk`,
          detail: `Only ${weekendCheckins}/${totalWeekends} weekend check-ins in last 4 weeks`,
          actionPath: '/habits',
          actionLabel: 'View',
          data: { habitId: habit.id, streak, weekendRate },
        })
      }
    }
  }

  // 3. Deadline miss projection — velocity vs remaining
  const goals = entities.filter(e => e.type === 'goal' && e.status !== 'done' && e.status !== 'archived' && e.dueDate)
  const projects = entities.filter(e => e.type === 'project' && e.status === 'in-progress' && e.dueDate)

  for (const entity of [...goals, ...projects]) {
    const tasks = entities.filter(e =>
      e.type === 'task' && e.status !== 'archived' &&
      (e.metadata?.goalId === entity.id || e.metadata?.projectId === entity.id)
    )
    const remaining = tasks.filter(t => t.status !== 'done').length
    if (remaining === 0) continue

    // 4-week velocity
    const fourWeeksAgo = new Date(now - 28 * MS_PER_DAY).toISOString()
    const doneRecently = tasks.filter(t => t.status === 'done' && t.updatedAt >= fourWeeksAgo).length
    const weeklyVelocity = doneRecently / 4
    if (weeklyVelocity === 0) continue

    const weeksNeeded = remaining / weeklyVelocity
    const projectedMs = now + weeksNeeded * 7 * MS_PER_DAY
    const dueMs = new Date(entity.dueDate!).getTime()

    if (projectedMs > dueMs) {
      const missBy = Math.ceil((projectedMs - dueMs) / MS_PER_DAY)
      insights.push({
        id: `threat-deadline-${entity.id}`,
        type: 'risk',
        category: entity.type === 'goal' ? 'goals' : 'projects',
        severity: missBy > 14 ? 3 : 2,
        title: `"${entity.title}" will miss deadline by ~${missBy} days`,
        detail: `${remaining} tasks left at ${weeklyVelocity.toFixed(1)}/week. Due: ${entity.dueDate}`,
        actionPath: entity.type === 'goal' ? `/goals?id=${entity.id}` : `/projects?id=${entity.id}`,
        actionLabel: 'View',
        data: { entityId: entity.id, remaining, weeklyVelocity, missBy, dueDate: entity.dueDate },
      })
    }
  }

  // 4. Sleep crash prediction — declining trend
  const sleepEntries = entities
    .filter(e => e.type === 'sleep-mood' && typeof e.metadata?.sleepHours === 'number')
    .sort((a, b) => ((b.metadata?.date as string) || '').localeCompare((a.metadata?.date as string) || ''))
    .slice(0, 14)

  if (sleepEntries.length >= 7) {
    const recent7 = sleepEntries.slice(0, 7).map(e => e.metadata?.sleepHours as number)
    const older7 = sleepEntries.slice(7, 14).map(e => e.metadata?.sleepHours as number)
    const recentAvg = recent7.reduce((a, b) => a + b, 0) / recent7.length
    const olderAvg = older7.length > 0 ? older7.reduce((a, b) => a + b, 0) / older7.length : recentAvg

    // Check if declining
    if (recentAvg < olderAvg - 0.3 && recentAvg < 7) {
      const declineRate = (olderAvg - recentAvg) / 7 // per day
      const daysUntilCritical = declineRate > 0 ? Math.floor((recentAvg - 5.5) / declineRate) : 99
      if (daysUntilCritical < 14 && daysUntilCritical > 0) {
        insights.push({
          id: 'threat-sleep',
          type: 'warning',
          category: 'health',
          severity: daysUntilCritical <= 5 ? 3 : 2,
          title: `Sleep declining — will hit critical (5.5h) in ~${daysUntilCritical} days`,
          detail: `Current: ${recentAvg.toFixed(1)}h avg, was ${olderAvg.toFixed(1)}h`,
          actionPath: '/health',
          actionLabel: 'View',
          data: { recentAvg, olderAvg, daysUntilCritical },
        })
      }
    }
  }

  return insights
}
