import type { Detector, Insight } from './types'
import { getProjectVelocity } from './utils'

export const detectVelocity: Detector = ({ entities, now }) => {
  const insights: Insight[] = []

  const projects = entities.filter(
    (e) => e.type === 'project' && e.status === 'in-progress',
  )

  for (const project of projects) {
    const { thisWeek: doneThisWeek, lastWeek: doneLastWeek } = getProjectVelocity(entities, project.id, now)

    if (doneLastWeek === 0 && doneThisWeek === 0) continue

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
