import { useCallback } from 'react'
import { useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { useEnergy } from '@/hooks/use-energy'

const ENERGY_ENTITY_ID = 'energy-tracker'

const LEVELS = [1, 2, 3, 4, 5] as const

export function EnergyCheckin() {
  const { create } = useTrackers()
  const userId = useAuthStore((s) => s.currentUser?.id ?? 'default')
  const { todayMorning, todayAfternoon } = useEnergy()

  const hour = new Date().getHours()
  const currentSlot: 'morning' | 'afternoon' = hour < 13 ? 'morning' : 'afternoon'
  const otherSlot = currentSlot === 'morning' ? 'afternoon' : 'morning'
  const currentValue = currentSlot === 'morning' ? todayMorning : todayAfternoon
  const otherValue = currentSlot === 'morning' ? todayAfternoon : todayMorning

  const handleCheckin = useCallback(
    (level: number) => {
      create.mutate({
        id: crypto.randomUUID(),
        entityId: ENERGY_ENTITY_ID,
        value: level,
        unit: 'energy',
        note: currentSlot,
        timestamp: new Date().toISOString(),
        ownerId: userId,
      })
    },
    [create, currentSlot, userId],
  )

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60 w-6 shrink-0">
          {currentSlot === 'morning' ? 'AM' : 'PM'}
        </span>
        <div className="flex gap-1">
          {LEVELS.map((level) => {
            const isSelected = currentValue === level
            return (
              <button
                key={level}
                onClick={() => handleCheckin(level)}
                className={`h-6 w-6 rounded-full text-[10px] font-semibold transition-colors ${
                  isSelected
                    ? 'bg-amber-500 text-white shadow-sm'
                    : 'bg-muted/60 text-muted-foreground hover:bg-muted'
                }`}
              >
                {level}
              </button>
            )
          })}
        </div>
      </div>

      {otherValue !== null && (
        <p className="text-[10px] text-muted-foreground/50 pl-7">
          {otherSlot === 'morning' ? 'AM' : 'PM'}: {otherValue}/5
        </p>
      )}
    </div>
  )
}
