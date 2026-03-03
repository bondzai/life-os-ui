import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { ENTITY_TYPE_LABELS, ASSIGNEES } from './family-helpers'
import type { Entity } from '@/core/types'

interface ActivityFeedProps {
  entities: Entity[]
}

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Yesterday'
  if (days < 7) return `${days}d ago`
  return new Date(iso).toLocaleDateString()
}

export function ActivityFeed({ entities }: ActivityFeedProps) {
  return (
    <div className="space-y-2">
      {entities.map((entity) => {
        const authorName = ASSIGNEES.find((a) => a.id === entity.ownerId)?.name ?? entity.ownerId
        const initials = authorName.charAt(0).toUpperCase()
        const typeLabel = ENTITY_TYPE_LABELS[entity.type] ?? entity.type

        return (
          <Card key={entity.id}>
            <CardContent className="py-3 flex items-start gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground text-sm font-medium">
                {initials}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium">{authorName}</span>
                  <Badge variant="outline" className="text-xs">
                    {typeLabel}
                  </Badge>
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(entity.updatedAt)}
                  </span>
                </div>
                <p className="text-sm mt-0.5 truncate">{entity.title}</p>
                {entity.description && (
                  <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{entity.description}</p>
                )}
              </div>
              <Badge variant="secondary" className="text-xs capitalize shrink-0">
                {entity.status}
              </Badge>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
