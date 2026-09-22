import { create } from 'zustand'

interface UiState {
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  commandBarOpen: boolean
  setCommandBarOpen: (open: boolean) => void
  /**
   * Text the palette opens with.
   *
   * How a shortcut says "open ⌘K, already in capture mode" without a second dialog existing to
   * hold that state. Cleared by the palette once it has read it, so reopening by hand is a blank
   * field rather than whatever the last shortcut seeded.
   */
  commandBarSeed: string
  openCommandBar: (seed?: string) => void
  focusMode: boolean
  setFocusMode: (on: boolean) => void
  toggleFocusMode: () => void
}

export const useUiStore = create<UiState>()((set) => ({
  sidebarOpen: true,
  setSidebarOpen: (open) => set({ sidebarOpen: open }),
  toggleSidebar: () => set((state) => ({ sidebarOpen: !state.sidebarOpen })),
  commandBarOpen: false,
  setCommandBarOpen: (open) => set({ commandBarOpen: open }),
  commandBarSeed: '',
  openCommandBar: (seed = '') => set({ commandBarOpen: true, commandBarSeed: seed }),
  focusMode: false,
  setFocusMode: (on) => set({ focusMode: on }),
  toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),
}))
