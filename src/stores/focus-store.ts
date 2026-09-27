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
  /**
   * Wall-clock ms at which the current phase ends, or `null` when nothing is counting down.
   *
   * This, not `secondsLeft`, is what the timer actually runs on. `secondsLeft` was persisted on
   * its own, so time only passed while a tick was firing: close the tab mid-block and reopen it
   * the next morning and the countdown resumed from where you left it, as if the night had not
   * happened. A deadline cannot drift — it is the same instant whether the tab was closed, the
   * laptop was asleep, or the browser was throttling the interval in a background tab.
   *
   * `secondsLeft` stays in the state because the whole UI reads it, but while `isRunning` it is a
   * cache of `runningUntil - now`, refreshed on every tick.
   */
  runningUntil: number | null

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

/**
 * The two ways a timer can be: counting down to a deadline, or holding a number.
 *
 * Every transition goes through one of these, so `isRunning`, `secondsLeft` and `runningUntil`
 * cannot disagree — a running timer without a deadline is the bug this pair exists to prevent.
 */
const counting = (seconds: number) => ({
  secondsLeft: seconds,
  isRunning: true,
  runningUntil: Date.now() + seconds * 1000,
})
const holding = (seconds: number) => ({
  secondsLeft: seconds,
  isRunning: false,
  runningUntil: null,
})

/** Whole seconds until a deadline, never negative. */
const secondsUntil = (deadline: number) => Math.max(0, Math.ceil((deadline - Date.now()) / 1000))

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
      runningUntil: null,
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
          ...counting(settings.workMinutes * 60),
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
          ...holding(settings.workMinutes * 60),
        })
      },

      setPhase: (phase) => {
        const { settings } = get()
        let seconds = settings.workMinutes * 60
        if (phase === 'break') seconds = settings.breakMinutes * 60
        else if (phase === 'long-break') seconds = settings.longBreakMinutes * 60
        const running = phase === 'work' || phase === 'break' || phase === 'long-break'
        set({ phase, ...(running ? counting(seconds) : holding(seconds)) })
      },

      // Read off the deadline rather than decremented. A decrement loses whatever the browser
      // took away — a throttled background tab fires this far less than once a second — so the
      // old timer ran slow exactly when you were not watching it.
      tick: () => {
        const { runningUntil } = get()
        if (runningUntil === null) return false
        const left = secondsUntil(runningUntil)
        if (left <= 0) {
          set(holding(0))
          return true
        }
        set({ secondsLeft: left })
        return false
      },

      pauseTimer: () => {
        const { runningUntil, secondsLeft } = get()
        // Freeze what is actually left, not what was last rendered.
        set(holding(runningUntil === null ? secondsLeft : secondsUntil(runningUntil)))
      },
      resumeTimer: () => set(counting(get().secondsLeft)),
      setSecondsLeft: (seconds) =>
        set(get().isRunning ? counting(seconds) : { secondsLeft: seconds }),

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
          ...(nextPhase === 'idle' ? holding(seconds) : counting(seconds)),
        })
      },

      completeBreak: () => {
        const { settings } = get()
        set({ phase: 'idle', ...holding(settings.workMinutes * 60) })
      },

      endDeepWork: () => set({
        activeEntityId: null,
        emperorEntityIds: [],
        sessionId: null,
        phase: 'idle',
        currentSession: 1,
        completedSessions: 0,
        ...holding(0),
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
    {
      name: 'lyra:focus',
      /**
       * Catch the timer up with the clock on the way back in.
       *
       * Three cases, and the third is the one worth arguing about:
       *
       * 1. **Still within the deadline.** Recompute what is left. This is the whole point — an
       *    hour of the tab being closed is an hour off the block.
       * 2. **Running, but saved before this field existed.** Take `secondsLeft` at face value one
       *    last time and give it a deadline, so an upgrade mid-session does not strand anyone.
       * 3. **The deadline passed while you were away.** The block is over, so the timer stops —
       *    but it deliberately does *not* count the block as completed. `handleTimerEnd` writes a
       *    `focus-min` tracker, and crediting a full pomodoro to someone who shut the laptop and
       *    went to bed would quietly corrupt the one number this feature exists to produce. It
       *    returns to `idle` with the session still open: nothing claimed, nothing lost, and the
       *    Start Focus screen (which now also offers End session) is waiting.
       */
      onRehydrateStorage: () => (state) => {
        if (!state || !state.isRunning) return
        if (state.runningUntil === null || state.runningUntil === undefined) {
          state.runningUntil = Date.now() + state.secondsLeft * 1000
          return
        }
        const left = secondsUntil(state.runningUntil)
        if (left > 0) {
          state.secondsLeft = left
          return
        }
        state.phase = 'idle'
        state.isRunning = false
        state.runningUntil = null
        state.secondsLeft = state.settings.workMinutes * 60
      },
    },
  ),
)
