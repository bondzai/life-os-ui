import { useMemo, useCallback } from 'react'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import type { Entity } from '@/core/types'

export type MemoryCategory = 'fact' | 'preference' | 'pattern' | 'decision' | 'context'

export interface LyraMemory {
  entity: Entity
  category: MemoryCategory
  source: string
  confidence: number
}

export function useLyraMemory() {
  const { items: entities, create, remove } = useEntities('memory')
  const currentUser = useAuthStore((s) => s.currentUser)

  const memories = useMemo((): LyraMemory[] => {
    return entities
      .filter((e) => e.status !== 'archived')
      .map((e) => ({
        entity: e,
        category: (e.metadata?.category as MemoryCategory) ?? 'fact',
        source: (e.metadata?.source as string) ?? 'unknown',
        confidence: (e.metadata?.confidence as number) ?? 0.5,
      }))
      .sort((a, b) => b.entity.updatedAt.localeCompare(a.entity.updatedAt))
  }, [entities])

  const addMemory = useCallback(
    (title: string, category: MemoryCategory, detail?: string, source?: string) => {
      // Check for duplicate (same title)
      if (
        entities.some(
          (e) => e.title.toLowerCase() === title.toLowerCase() && e.status !== 'archived',
        )
      )
        return

      create.mutate({
        id: crypto.randomUUID(),
        type: 'memory',
        title,
        description: detail,
        status: 'todo',
        priority: 'medium',
        tags: [category],
        metadata: { category, source: source ?? 'chat', confidence: 0.8 },
        ownerId: currentUser?.id ?? '',
        visibility: 'private',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
    },
    [entities, create, currentUser],
  )

  const removeMemory = useCallback(
    (id: string) => {
      remove.mutate(id)
    },
    [remove],
  )

  const getRelevantMemories = useCallback(
    (query: string, limit = 5): LyraMemory[] => {
      if (!query.trim()) return memories.slice(0, limit)
      const lower = query.toLowerCase()
      const words = lower.split(/\s+/).filter((w) => w.length > 2)

      return memories
        .map((m) => {
          const text =
            `${m.entity.title} ${m.entity.description ?? ''} ${m.entity.tags.join(' ')}`.toLowerCase()
          const score = words.reduce((s, w) => s + (text.includes(w) ? 1 : 0), 0)
          return { ...m, score }
        })
        .filter((m) => m.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
    },
    [memories],
  )

  return { memories, addMemory, removeMemory, getRelevantMemories }
}
