import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '@/core/types'

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3001/api'

interface AuthState {
  currentUser: User | null
  isAuthenticated: boolean
  login: (user: User) => void
  loginWithApi: (pin: string) => Promise<void>
  logout: () => void
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      currentUser: null,
      isAuthenticated: false,
      login: (user) => set({ currentUser: user, isAuthenticated: true }),
      loginWithApi: async (pin: string) => {
        const res = await fetch(`${API_URL}/auth/login`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin }),
        })
        if (!res.ok) {
          const error = await res.json().catch(() => ({ message: 'Login failed' }))
          throw new Error(error.message || 'Login failed')
        }
        const data = await res.json()
        localStorage.setItem('life-os:token', data.token)
        set({ currentUser: data.user, isAuthenticated: true })
      },
      logout: () => {
        localStorage.removeItem('life-os:token')
        set({ currentUser: null, isAuthenticated: false })
      },
    }),
    {
      name: 'life-os:auth',
    },
  ),
)
