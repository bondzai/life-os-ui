import { TrendingDown, TrendingUp, Minus } from 'lucide-react'
import { registerWidget, type WidgetProps } from './registry'

function startOfWeek(d: Date): Date {
  const r = new Date(d)
  const day = r.getDay()
  r.setDate(r.getDate() - (day === 0 ? 6 : day - 1))
  r.setHours(0, 0, 0, 0)
  return r
}

function ProjectVelocity({ entities }: WidgetProps) {
  const now = new Date()
  const thisWeekStart = startOfWeek(now)
  const lastWeekStart = new Date(thisWeekStart)
  lastWeekStart.setDate(lastWeekStart.getDate() - 7)

  const projects = entities.filter(
    (e) => e.type === 'project' && e.status === 'in-progress',
  )
  const tasks = entities.filter((e) => e.type === 'task' && e.status === 'done')

  const projectData = projects.map((p) => {
    const linked = tasks.filter((t) => t.parentId === p.id)
    const thisWeek = linked.filter(
      (t) => new Date(t.updatedAt) >= thisWeekStart,
    ).length
    const lastWeek = linked.filter(
      (t) => new Date(t.updatedAt) >= lastWeekStart && new Date(t.updatedAt) < thisWeekStart,
    ).length
    return { project: p, thisWeek, lastWeek }
  })

  if (projectData.length === 0)
    return <p className="text-xs text-muted-foreground">No active projects</p>

  return (
    <div className="space-y-2">
      {projectData.slice(0, 5).map(({ project, thisWeek, lastWeek }) => {
        const max = Math.max(thisWeek, lastWeek, 1)
        return (
          <div key={project.id} className="space-y-0.5">
            <div className="flex items-center justify-between">
              <span className="text-sm truncate">{project.title}</span>
              <div className="flex items-center gap-1 text-xs shrink-0">
                <span>{thisWeek}</span>
                {thisWeek > lastWeek ? (
                  <TrendingUp className="size-3 text-emerald-500" />
                ) : thisWeek < lastWeek ? (
                  <TrendingDown className="size-3 text-red-500" />
                ) : (
                  <Minus className="size-3 text-muted-foreground" />
                )}
              </div>
            </div>
            <div className="flex gap-0.5 h-1.5">
              <div
                className="bg-muted-foreground/30 rounded-full"
                style={{ width: `${(lastWeek / max) * 100}%` }}
              />
              <div
                className="bg-primary rounded-full"
                style={{ width: `${(thisWeek / max) * 100}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

registerWidget(
  {
    id: 'project-velocity',
    name: 'Project Velocity',
    relevance: ({ entities }) => {
      const now = new Date()
      const thisWeekStart = startOfWeek(now)
      const projects = entities.filter(
        (e) => e.type === 'project' && e.status === 'in-progress',
      )
      if (projects.length === 0) return null
      const tasks = entities.filter((e) => e.type === 'task' && e.status === 'done')
      const droppedToZero = projects.some((p) => {
        const linked = tasks.filter((t) => t.parentId === p.id)
        return linked.filter((t) => new Date(t.updatedAt) >= thisWeekStart).length === 0
      })
      return droppedToZero ? 3 : 2
    },
  },
  ProjectVelocity,
)
