import { useMemo } from 'react'
import { useEntities } from './use-entities'
import type { Entity } from '@/core/types'

export type ScoredEntity = Entity & { _score: number }

function scoreMatch(text: string | undefined, query: string): boolean {
  if (!text) return false
  return text.toLowerCase().includes(query)
}

export function useFullTextSearch(query: string): ScoredEntity[] {
  const { items: entities } = useEntities()

  return useMemo(() => {
    const q = query.toLowerCase().trim()
    if (!q) return []

    const scored: ScoredEntity[] = []

    for (const entity of entities) {
      let score = 0

      if (scoreMatch(entity.title, q)) score += 3
      if (scoreMatch(entity.description, q)) score += 2
      if (entity.tags.some((tag) => tag.toLowerCase().includes(q))) score += 1

      const body = entity.metadata.body
      if (typeof body === 'string' && body.toLowerCase().includes(q)) score += 1

      const author = entity.metadata.author
      if (typeof author === 'string' && author.toLowerCase().includes(q)) score += 1

      if (score > 0) {
        scored.push({ ...entity, _score: score })
      }
    }

    scored.sort((a, b) => b._score - a._score)
    return scored
  }, [entities, query])
}
