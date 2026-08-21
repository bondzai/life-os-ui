import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { User } from '@/core/types'
import { API_URL } from '@/lib/api-url'

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
        localStorage.setItem('lyra:token', data.token)
        set({ currentUser: data.user, isAuthenticated: true })
      },
      logout: () => {
        localStorage.removeItem('lyra:token')
        // The data mode belongs to the session, not to the browser. Leaving it behind is what
        // made "sign out and sign back in" unable to escape a demo or local session — the next
        // sign-in read the stale mode and served mock data against a healthy API.
        localStorage.removeItem('lyra:data-mode')
        set({ currentUser: null, isAuthenticated: false })
      },
    }),
    {
      name: 'lyra:auth',
    },
  ),
)
