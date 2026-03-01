import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '@/core/types'

interface AuthState {
  currentUser: User | null
  isAuthenticated: boolean
  login: (user: User) => void
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      currentUser: null,
      isAuthenticated: false,
      login: (user) => set({ currentUser: user, isAuthenticated: true }),
      logout: () => set({ currentUser: null, isAuthenticated: false }),
    }),
    {
      name: 'life-os:auth',
    },
  ),
)
