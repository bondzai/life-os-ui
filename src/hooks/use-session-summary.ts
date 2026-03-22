import { useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useFocusStore } from '@/stores/focus-store'
import { useEntities, useTrackers } from '@/core/hooks'

export function useSessionSummary() {
  const phase = useFocusStore((s) => s.phase)
  const completedSessions = useFocusStore((s) => s.completedSessions)
  const entityIds = useFocusStore((s) => s.emperorEntityIds)
  const prevPhase = useRef(phase)
  const { items: entities } = useEntities()
  const { items: trackers } = useTrackers()

  useEffect(() => {
    // Detect work → break transition
    if (
      prevPhase.current === 'work' &&
      (phase === 'break' || phase === 'long-break')
    ) {
      // Build summary
      const sessionNum = completedSessions
      const focusEntities = entities.filter((e) => entityIds.includes(e.id))

      // Count subtasks completed (rough: entities with subtasks where some are done)
      let subtasksDone = 0
      for (const entity of focusEntities) {
        const subs = Array.isArray(entity.metadata?.subtasks)
          ? (entity.metadata.subtasks as Array<{
              done: boolean
              status?: string
            }>)
          : []
        subtasksDone += subs.filter(
          (s) => s.status === 'done' || s.done
        ).length
      }

      // Check streak risks
      const todayStart = new Date().toISOString().split('T')[0] + 'T00:00:00'
      const atRiskHabits = entities.filter(
        (e) =>
          e.type === 'habit' &&
          e.status === 'todo' &&
          typeof e.metadata?.streak === 'number' &&
          (e.metadata.streak as number) >= 3 &&
          !trackers.some(
            (t) => t.entityId === e.id && t.timestamp >= todayStart
          )
      )

      // Build message
      const parts: string[] = []
      parts.push(`Session ${sessionNum} done.`)
      if (focusEntities.length > 0) {
        parts.push(
          `Working on: ${focusEntities
            .map((e) => e.title)
            .slice(0, 2)
            .join(', ')}.`
        )
      }
      if (atRiskHabits.length > 0) {
        const h = atRiskHabits[0]
        const streak = h.metadata?.streak as number
        parts.push(`${h.title} (${streak}d streak) still waiting.`)
      }

      toast(parts.join(' '), { duration: 6000 })
    }
    prevPhase.current = phase
  }, [phase, completedSessions, entityIds, entities, trackers])
}
