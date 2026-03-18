import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export interface SavedFilter {
  id: string
  name: string
  criteria: Record<string, string>
}

interface FilterState {
  saved: Record<string, SavedFilter[]>
  active: Record<string, string | null>
  saveFilter: (module: string, filter: SavedFilter) => void
  removeFilter: (module: string, filterId: string) => void
  setActive: (module: string, filterId: string | null) => void
}

export const useFilterStore = create<FilterState>()(
  persist(
    (set) => ({
      saved: {},
      active: {},

      saveFilter: (module, filter) =>
        set((state) => ({
          saved: {
            ...state.saved,
            [module]: [...(state.saved[module] ?? []), filter],
          },
        })),

      removeFilter: (module, filterId) =>
        set((state) => {
          const filters = (state.saved[module] ?? []).filter((f) => f.id !== filterId)
          const active = state.active[module] === filterId ? null : state.active[module]
          return {
            saved: { ...state.saved, [module]: filters },
            active: { ...state.active, [module]: active },
          }
        }),

      setActive: (module, filterId) =>
        set((state) => ({
          active: { ...state.active, [module]: filterId },
        })),
    }),
    { name: 'lyra:saved-filters' },
  ),
)
