import { create } from 'zustand'
import { persist } from 'zustand/middleware'

type TimerPreset = 'classic' | 'deep' | 'sprint' | 'custom'
type TimerPhase = 'idle' | 'work' | 'break' | 'long-break'

interface FocusSettings {
  workMinutes: number
  breakMinutes: number
  longBreakMinutes: number
  sessionsBeforeLongBreak: number
  autoStartBreak: boolean
  soundEnabled: boolean
}

const PRESETS: Record<string, FocusSettings> = {
  classic: { workMinutes: 25, breakMinutes: 5, longBreakMinutes: 15, sessionsBeforeLongBreak: 4, autoStartBreak: true, soundEnabled: true },
  deep: { workMinutes: 50, breakMinutes: 10, longBreakMinutes: 20, sessionsBeforeLongBreak: 3, autoStartBreak: true, soundEnabled: true },
  sprint: { workMinutes: 90, breakMinutes: 20, longBreakMinutes: 30, sessionsBeforeLongBreak: 2, autoStartBreak: true, soundEnabled: true },
}

interface FocusState {
  // Active session
  activeEntityId: string | null
  phase: TimerPhase
  currentSession: number
  completedSessions: number

  // Settings
  preset: TimerPreset
  settings: FocusSettings

  // Actions
  startSession: (entityId: string) => void
  setPhase: (phase: TimerPhase) => void
  completeWorkSession: () => void
  completeBreak: () => void
  endDeepWork: () => void
  setPreset: (preset: TimerPreset) => void
  updateSettings: (settings: Partial<FocusSettings>) => void
}

export const useFocusStore = create<FocusState>()(
  persist(
    (set, get) => ({
      activeEntityId: null,
      phase: 'idle',
      currentSession: 1,
      completedSessions: 0,
      preset: 'classic',
      settings: PRESETS.classic,

      startSession: (entityId) => set({ activeEntityId: entityId, phase: 'work', currentSession: 1, completedSessions: 0 }),

      setPhase: (phase) => set({ phase }),

      completeWorkSession: () => {
        const { currentSession, completedSessions, settings } = get()
        const newCompleted = completedSessions + 1
        const isLongBreak = newCompleted % settings.sessionsBeforeLongBreak === 0
        set({
          completedSessions: newCompleted,
          phase: settings.autoStartBreak ? (isLongBreak ? 'long-break' : 'break') : 'idle',
          currentSession: currentSession + 1,
        })
      },

      completeBreak: () => set({ phase: 'idle' }),

      endDeepWork: () => set({ activeEntityId: null, phase: 'idle', currentSession: 1, completedSessions: 0 }),

      setPreset: (preset) => {
        if (preset !== 'custom' && PRESETS[preset]) {
          set({ preset, settings: PRESETS[preset] })
        } else {
          set({ preset })
        }
      },

      updateSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial }, preset: 'custom' })),
    }),
    { name: 'life-os:focus' },
  ),
)

export { PRESETS }
export type { TimerPreset, TimerPhase, FocusSettings }
