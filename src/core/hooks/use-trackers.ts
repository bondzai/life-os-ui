import { useMemo } from 'react'
import { trackerRepository } from '@/core/repositories'
import { useRepository } from './use-repository'

export function useTrackers(entityId?: string) {
  const result = useRepository('trackers', trackerRepository)

  const items = useMemo(
    () => (entityId ? result.items.filter((t) => t.entityId === entityId) : result.items),
    [result.items, entityId],
  )

  return { ...result, items }
}
