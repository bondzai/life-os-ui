import type { Detector, Insight } from './types'

const MS_PER_WEEK = 7 * 86_400_000

export const detectVelocity: Detector = ({ entities, now }) => {
  const insights: Insight[] = []

  const projects = entities.filter(
    (e) => e.type === 'project' && e.status === 'in-progress',
  )

  const thisWeekStart = new Date(now - MS_PER_WEEK).toISOString()
  const lastWeekStart = new Date(now - 2 * MS_PER_WEEK).toISOString()

  for (const project of projects) {
    const tasks = entities.filter(
      (e) => e.type === 'task' && e.metadata?.projectId === project.id,
    )

    const doneThisWeek = tasks.filter(
      (t) => t.status === 'done' && (t.updatedAt ?? t.createdAt) >= thisWeekStart,
    ).length

    const doneLastWeek = tasks.filter(
      (t) =>
        t.status === 'done' &&
        (t.updatedAt ?? t.createdAt) >= lastWeekStart &&
        (t.updatedAt ?? t.createdAt) < thisWeekStart,
    ).length

    if (doneLastWeek === 0 && doneThisWeek === 0) continue

    // Significant velocity increase
    if (doneThisWeek >= 3 && doneLastWeek > 0 && doneThisWeek >= doneLastWeek * 2) {
      insights.push({
        id: `velocity-up-${project.id}`,
        type: 'achievement',
        category: 'projects',
        severity: 1,
        title: `"${project.title}" velocity doubled (${doneLastWeek}→${doneThisWeek} tasks/week)`,
        actionLabel: 'View',
        actionPath: `/projects?id=${project.id}`,
        data: { projectId: project.id, thisWeek: doneThisWeek, lastWeek: doneLastWeek },
      })
    }

    // Significant drop
    if (doneLastWeek >= 3 && doneThisWeek <= Math.floor(doneLastWeek / 2)) {
      insights.push({
        id: `velocity-down-${project.id}`,
        type: 'risk',
        category: 'projects',
        severity: 2,
        title: `"${project.title}" velocity dropped (${doneLastWeek}→${doneThisWeek} tasks/week)`,
        actionLabel: 'View',
        actionPath: `/projects?id=${project.id}`,
        data: { projectId: project.id, thisWeek: doneThisWeek, lastWeek: doneLastWeek },
      })
    }
  }

  return insights
}
