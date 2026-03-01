import type { EntityType } from '@/core/types'
import { useEntities } from '@/core/hooks'
import { EntityCard } from './entity-card'
import { EmptyState } from './empty-state'
import { Package } from 'lucide-react'

interface EntityListProps {
  type: EntityType
  onSelect?: (id: string) => void
  emptyMessage?: string
}

export function EntityList({ type, onSelect, emptyMessage }: EntityListProps) {
  const { items, isLoading } = useEntities(type)

  if (isLoading) {
    return <div className="text-sm text-muted-foreground p-4">Loading...</div>
  }

  if (items.length === 0) {
    return (
      <EmptyState
        icon={Package}
        title={emptyMessage ?? `No ${type}s yet`}
        description={`Create your first ${type} to get started.`}
      />
    )
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {items.map((entity) => (
        <EntityCard
          key={entity.id}
          entity={entity}
          onClick={onSelect ? () => onSelect(entity.id) : undefined}
        />
      ))}
    </div>
  )
}
