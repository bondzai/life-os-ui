import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type LogLevel = 'info' | 'action' | 'thinking' | 'error' | 'celebration'

export interface LyraLogEntry {
  id: string
  timestamp: string
  level: LogLevel
  source: string        // which system: 'pulse', 'celebration', 'session', 'ai-tool', 'capture', 'strategy'
  message: string
  detail?: string       // extra context
  entityId?: string     // related entity
  duration?: number     // ms if async operation
}

interface LyraLogState {
  entries: LyraLogEntry[]
  add: (entry: Omit<LyraLogEntry, 'id' | 'timestamp'>) => void
  clear: () => void
}

const MAX_ENTRIES = 200

export const useLyraLogStore = create<LyraLogState>()(
  persist(
    (set) => ({
      entries: [],
      add: (entry) =>
        set((state) => ({
          entries: [
            { ...entry, id: crypto.randomUUID(), timestamp: new Date().toISOString() },
            ...state.entries,
          ].slice(0, MAX_ENTRIES),
        })),
      clear: () => set({ entries: [] }),
    }),
    { name: 'lyra:log' },
  ),
)

/** Helper to log from anywhere */
export function lyraLog(entry: Omit<LyraLogEntry, 'id' | 'timestamp'>) {
  useLyraLogStore.getState().add(entry)
}
