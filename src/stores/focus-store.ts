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
  // Active session — single entity or emperor mode (all focus tasks)
  activeEntityId: string | null
  emperorEntityIds: string[]
  sessionId: string | null
  phase: TimerPhase
  currentSession: number
  completedSessions: number

  // Timer state (persisted so it survives navigation)
  secondsLeft: number
  isRunning: boolean

  // Settings
  preset: TimerPreset
  settings: FocusSettings

  // Actions
  startSession: (entityId: string) => void
  startEmperorTime: (entityIds: string[]) => void
  setPhase: (phase: TimerPhase) => void
  tick: () => boolean // returns true when timer reaches 0
  pauseTimer: () => void
  resumeTimer: () => void
  setSecondsLeft: (seconds: number) => void
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
      emperorEntityIds: [],
      sessionId: null,
      phase: 'idle',
      currentSession: 1,
      completedSessions: 0,
      secondsLeft: 0,
      isRunning: false,
      preset: 'classic',
      settings: PRESETS.classic,

      startSession: (entityId) => {
        const { settings } = get()
        set({
          activeEntityId: entityId,
          emperorEntityIds: [],
          sessionId: crypto.randomUUID(),
          phase: 'work',
          currentSession: 1,
          completedSessions: 0,
          secondsLeft: settings.workMinutes * 60,
          isRunning: true,
        })
      },

      startEmperorTime: (entityIds) => {
        const { settings } = get()
        set({
          activeEntityId: entityIds[0] ?? null,
          emperorEntityIds: entityIds,
          sessionId: crypto.randomUUID(),
          phase: 'idle',
          currentSession: 1,
          completedSessions: 0,
          secondsLeft: settings.workMinutes * 60,
          isRunning: false,
        })
      },

      setPhase: (phase) => {
        const { settings } = get()
        let seconds = settings.workMinutes * 60
        if (phase === 'break') seconds = settings.breakMinutes * 60
        else if (phase === 'long-break') seconds = settings.longBreakMinutes * 60
        const running = phase === 'work' || phase === 'break' || phase === 'long-break'
        set({ phase, secondsLeft: seconds, isRunning: running })
      },

      tick: () => {
        const { secondsLeft } = get()
        if (secondsLeft <= 1) {
          set({ secondsLeft: 0, isRunning: false })
          return true
        }
        set({ secondsLeft: secondsLeft - 1 })
        return false
      },

      pauseTimer: () => set({ isRunning: false }),
      resumeTimer: () => set({ isRunning: true }),
      setSecondsLeft: (seconds) => set({ secondsLeft: seconds }),

      completeWorkSession: () => {
        const { currentSession, completedSessions, settings } = get()
        const newCompleted = completedSessions + 1
        const isLongBreak = newCompleted % settings.sessionsBeforeLongBreak === 0
        const nextPhase = settings.autoStartBreak ? (isLongBreak ? 'long-break' : 'break') : 'idle'
        let seconds = settings.workMinutes * 60
        if (nextPhase === 'break') seconds = settings.breakMinutes * 60
        else if (nextPhase === 'long-break') seconds = settings.longBreakMinutes * 60
        set({
          completedSessions: newCompleted,
          phase: nextPhase,
          currentSession: currentSession + 1,
          secondsLeft: seconds,
          isRunning: nextPhase !== 'idle',
        })
      },

      completeBreak: () => {
        const { settings } = get()
        set({ phase: 'idle', secondsLeft: settings.workMinutes * 60, isRunning: false })
      },

      endDeepWork: () => set({
        activeEntityId: null,
        emperorEntityIds: [],
        sessionId: null,
        phase: 'idle',
        currentSession: 1,
        completedSessions: 0,
        secondsLeft: 0,
        isRunning: false,
      }),

      setPreset: (preset) => {
        if (preset !== 'custom' && PRESETS[preset]) {
          set({ preset, settings: PRESETS[preset] })
        } else {
          set({ preset })
        }
      },

      updateSettings: (partial) => set((s) => ({ settings: { ...s.settings, ...partial }, preset: 'custom' })),
    }),
    { name: 'lyra:focus' },
  ),
)
