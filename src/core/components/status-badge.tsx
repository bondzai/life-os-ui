import { Badge } from '@/components/ui/badge'
import type { EntityStatus } from '@/core/types'

const statusVariant: Record<EntityStatus, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  backlog: 'outline',
  todo: 'default',
  'in-progress': 'secondary',
  done: 'secondary',
  archived: 'outline',
}

export function StatusBadge({ status }: { status: EntityStatus }) {
  return <Badge variant={statusVariant[status]}>{status}</Badge>
}
