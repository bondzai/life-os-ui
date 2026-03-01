import { useMemo } from 'react'
import type { EntityType } from '@/core/types'
import { entityRepository } from '@/core/repositories'
import { useRepository } from './use-repository'

export function useEntities(type?: EntityType) {
  const result = useRepository('entities', entityRepository)

  const items = useMemo(
    () => (type ? result.items.filter((e) => e.type === type) : result.items),
    [result.items, type],
  )

  return { ...result, items }
}
