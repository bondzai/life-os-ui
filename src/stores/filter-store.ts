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
  getFilters: (module: string) => SavedFilter[]
  getActive: (module: string) => SavedFilter | null
}

export const useFilterStore = create<FilterState>()(
  persist(
    (set, get) => ({
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

      getFilters: (module) => get().saved[module] ?? [],

      getActive: (module) => {
        const activeId = get().active[module]
        if (!activeId) return null
        return (get().saved[module] ?? []).find((f) => f.id === activeId) ?? null
      },
    }),
    { name: 'life-os:saved-filters' },
  ),
)
