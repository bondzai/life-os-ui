import { useMemo } from 'react'
import { relationRepository } from '@/core/repositories'
import { useRepository } from './use-repository'

export function useRelations(entityId?: string) {
  const result = useRepository('relations', relationRepository)

  const items = useMemo(
    () =>
      entityId
        ? result.items.filter((r) => r.fromId === entityId || r.toId === entityId)
        : result.items,
    [result.items, entityId],
  )

  return { ...result, items }
}
