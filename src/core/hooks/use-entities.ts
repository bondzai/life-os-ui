import type { EntityType } from '@/core/types'
import { entityRepository } from '@/core/repositories'
import { useRepository } from './use-repository'

/**
 * Entities, optionally of one type.
 *
 * **Asking for a type now asks the server for it.** This used to fetch every entity the user owns
 * — all thirty types, metadata blobs and all, under a single `'entities'` cache key — and filter
 * in the browser. One project page pulled every task, note, comment and transaction, and every
 * mutation anywhere invalidated and refetched the lot. `docs/roadmap.md` has flagged it since the
 * API landed; the server filter and `getByType` were both already there, just unused.
 *
 * Calling it without a type is unchanged, deliberately: the pages that read across types (Goals
 * filtering `isGoal`, the dashboard widgets, the AI context builders) still get one shared cache
 * entry holding everything, exactly as before. Narrowing those is a per-page decision, not
 * something to force here.
 */
export function useEntities(type?: EntityType) {
  return useRepository(
    'entities',
    entityRepository,
    type
      ? { scope: type, fetch: () => entityRepository.getByType(type) }
      : undefined,
  )
}
