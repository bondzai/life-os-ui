import type { Detector, Insight } from './types'

const STALE_DAYS = 14
const MS_PER_DAY = 86_400_000

export const detectStaleProjects: Detector = ({ entities, now }) => {
  const insights: Insight[] = []
  const projects = entities.filter(
    (e) => e.type === 'project' && e.status === 'in-progress',
  )

  for (const project of projects) {
    const tasks = entities.filter(
      (e) => e.type === 'task' && e.status !== 'archived' && e.metadata?.projectId === project.id,
    )

    // Most recent task activity
    let latestMs = new Date(project.updatedAt ?? project.createdAt).getTime()
    for (const t of tasks) {
      const tMs = new Date(t.updatedAt ?? t.createdAt).getTime()
      if (tMs > latestMs) latestMs = tMs
    }

    const daysSince = Math.floor((now - latestMs) / MS_PER_DAY)
    if (daysSince >= STALE_DAYS) {
      insights.push({
        id: `stale-project-${project.id}`,
        type: 'risk',
        category: 'projects',
        severity: daysSince >= 30 ? 3 : 2,
        title: `"${project.title}" — no activity in ${daysSince}d`,
        actionLabel: 'View',
        actionPath: `/projects?id=${project.id}`,
        data: { projectId: project.id, daysSince, title: project.title },
      })
    }
  }

  return insights
}
