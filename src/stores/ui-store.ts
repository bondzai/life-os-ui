import { create } from 'zustand'

interface UiState {
  sidebarOpen: boolean
  setSidebarOpen: (open: boolean) => void
  toggleSidebar: () => void
  commandBarOpen: boolean
  setCommandBarOpen: (open: boolean) => void
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
  focusMode: false,
  setFocusMode: (on) => set({ focusMode: on }),
  toggleFocusMode: () => set((state) => ({ focusMode: !state.focusMode })),
}))
