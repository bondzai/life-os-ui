import { useMemo } from 'react'
import { scheduleRepository } from '@/core/repositories'
import { useRepository } from './use-repository'

export function useSchedules(entityId?: string) {
  const result = useRepository('schedules', scheduleRepository)

  const items = useMemo(
    () => (entityId ? result.items.filter((s) => s.entityId === entityId) : result.items),
    [result.items, entityId],
  )

  return { ...result, items }
}
