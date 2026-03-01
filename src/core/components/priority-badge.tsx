import { Badge } from '@/components/ui/badge'
import type { EntityPriority } from '@/core/types'

const priorityVariant: Record<EntityPriority, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  low: 'outline',
  medium: 'secondary',
  high: 'default',
  urgent: 'destructive',
}

export function PriorityBadge({ priority }: { priority: EntityPriority }) {
  return <Badge variant={priorityVariant[priority]}>{priority}</Badge>
}
