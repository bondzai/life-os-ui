import type { Entity } from '@/core/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from './status-badge'
import { PriorityBadge } from './priority-badge'

interface EntityCardProps {
  entity: Entity
  onClick?: () => void
}

export function EntityCard({ entity, onClick }: EntityCardProps) {
  return (
    <Card
      className={onClick ? 'cursor-pointer hover:bg-accent/50 transition-colors' : ''}
      onClick={onClick}
    >
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium">{entity.title}</CardTitle>
          <div className="flex gap-1">
            <PriorityBadge priority={entity.priority} />
            <StatusBadge status={entity.status} />
          </div>
        </div>
      </CardHeader>
      <CardContent>
        {entity.description && (
          <p className="text-xs text-muted-foreground line-clamp-2">{entity.description}</p>
        )}
        {entity.tags.length > 0 && (
          <div className="flex gap-1 mt-2 flex-wrap">
            {entity.tags.map((tag) => (
              <span key={tag} className="text-xs bg-secondary px-1.5 py-0.5 rounded">
                {tag}
              </span>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
