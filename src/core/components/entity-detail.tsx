import type { Entity } from '@/core/types'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatusBadge } from './status-badge'
import { PriorityBadge } from './priority-badge'
import { EntityComments } from './entity-comments'

interface EntityDetailProps {
  entity: Entity
  children?: React.ReactNode
  showComments?: boolean
  currentUserId?: string
}

export function EntityDetail({ entity, children, showComments, currentUserId }: EntityDetailProps) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <CardTitle>{entity.title}</CardTitle>
          <div className="flex gap-2">
            <PriorityBadge priority={entity.priority} />
            <StatusBadge status={entity.status} />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {entity.description && (
          <p className="text-sm text-muted-foreground">{entity.description}</p>
        )}
        {entity.tags.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {entity.tags.map((tag) => (
              <span key={tag} className="text-xs bg-secondary px-2 py-0.5 rounded">
                {tag}
              </span>
            ))}
          </div>
        )}
        {entity.dueDate && (
          <p className="text-sm">
            <span className="text-muted-foreground">Due:</span>{' '}
            {new Date(entity.dueDate).toLocaleDateString()}
          </p>
        )}
        {children}
        {showComments && currentUserId && (
          <EntityComments entityId={entity.id} currentUserId={currentUserId} />
        )}
      </CardContent>
    </Card>
  )
}
