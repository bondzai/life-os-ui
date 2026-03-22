import { FolderClock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { registerWidget, type WidgetProps } from './registry'

const STALE_DAYS = 14

function StaleProjects({ entities }: WidgetProps) {
  const now = Date.now()
  const cutoff = now - STALE_DAYS * 86400000

  const projects = entities.filter(
    (e) => e.type === 'project' && e.status === 'in-progress',
  )
  const tasks = entities.filter(
    (e) => e.type === 'task' && e.parentId,
  )

  const stale = projects.filter((p) => {
    const linked = tasks.filter((t) => t.parentId === p.id)
    if (linked.length === 0) return true
    const latest = Math.max(...linked.map((t) => new Date(t.updatedAt).getTime()))
    return latest < cutoff
  })

  if (stale.length === 0)
    return <p className="text-xs text-muted-foreground">All projects active</p>

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-1.5 text-xs text-amber-500">
        <FolderClock className="size-3.5" />
        <span>{stale.length} stale project{stale.length !== 1 ? 's' : ''}</span>
      </div>
      {stale.slice(0, 5).map((p) => {
        const daysSince = Math.floor(
          (now - new Date(p.updatedAt).getTime()) / 86400000,
        )
        return (
          <div key={p.id} className="flex items-center justify-between gap-2">
            <span className="text-sm truncate">{p.title}</span>
            <Badge variant="outline" className="text-xs text-amber-500 shrink-0">
              {daysSince}d ago
            </Badge>
          </div>
        )
      })}
    </div>
  )
}

registerWidget(
  {
    id: 'stale-projects',
    name: 'Stale Projects',
    relevance: ({ entities }) => {
      const now = Date.now()
      const cutoff = now - STALE_DAYS * 86400000
      const projects = entities.filter(
        (e) => e.type === 'project' && e.status === 'in-progress',
      )
      const tasks = entities.filter((e) => e.type === 'task' && e.parentId)
      const hasStale = projects.some((p) => {
        const linked = tasks.filter((t) => t.parentId === p.id)
        if (linked.length === 0) return true
        const latest = Math.max(...linked.map((t) => new Date(t.updatedAt).getTime()))
        return latest < cutoff
      })
      return hasStale ? 3 : null
    },
  },
  StaleProjects,
)
