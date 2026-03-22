import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useEntities, useTrackers } from '@/core/hooks'
import { lyraLog } from '@/stores/lyra-log-store'

const MILESTONES = [7, 30, 90, 180, 365]

export function useCelebrations() {
  const { items: entities } = useEntities()
  const { items: trackers } = useTrackers()
  const prevEntities = useRef(new Map<string, string>()) // id → status
  const prevTrackerCount = useRef(new Map<string, number>()) // entityId → count
  const initialized = useRef(false)

  useEffect(() => {
    // Skip first render (don't toast on page load)
    if (!initialized.current) {
      // Initialize snapshots
      for (const e of entities) prevEntities.current.set(e.id, e.status)
      for (const e of entities.filter((e) => e.type === 'habit')) {
        prevTrackerCount.current.set(
          e.id,
          trackers.filter((t) => t.entityId === e.id).length
        )
      }
      initialized.current = true
      return
    }

    // Check for status changes
    for (const entity of entities) {
      const prevStatus = prevEntities.current.get(entity.id)

      // Task completed
      if (
        entity.type === 'task' &&
        prevStatus &&
        prevStatus !== 'done' &&
        entity.status === 'done'
      ) {
        lyraLog({ level: 'celebration', source: 'celebration', message: `Task "${entity.title}" completed`, entityId: entity.id })
        toast(`"${entity.title}" — done.`, { duration: 4000 })
      }

      // Goal completed
      if (
        entity.type === 'goal' &&
        prevStatus &&
        prevStatus !== 'done' &&
        entity.status === 'done'
      ) {
        const progress =
          typeof entity.metadata?.progress === 'number'
            ? entity.metadata.progress
            : 100
        lyraLog({ level: 'celebration', source: 'celebration', message: `Goal "${entity.title}" complete at ${progress}%`, entityId: entity.id })
        toast(`Goal "${entity.title}" complete. ${progress}%.`, {
          duration: 6000,
        })
      }

      // Habit streak milestone
      if (entity.type === 'habit') {
        const streak =
          typeof entity.metadata?.streak === 'number'
            ? (entity.metadata.streak as number)
            : 0
        const prevCount = prevTrackerCount.current.get(entity.id) ?? 0
        const currentCount = trackers.filter(
          (t) => t.entityId === entity.id
        ).length

        if (currentCount > prevCount && MILESTONES.includes(streak)) {
          lyraLog({ level: 'celebration', source: 'celebration', message: `"${entity.title}" hit ${streak}-day streak`, entityId: entity.id })
          toast(`"${entity.title}" — ${streak}-day streak. That's real.`, {
            duration: 6000,
          })
        }
        prevTrackerCount.current.set(entity.id, currentCount)
      }

      prevEntities.current.set(entity.id, entity.status)
    }
  }, [entities, trackers])
}
