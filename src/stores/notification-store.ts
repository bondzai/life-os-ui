import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type NotificationType = 'success' | 'error' | 'info' | 'warning'

export interface NotificationItem {
  id: string
  title: string
  message?: string
  type: NotificationType
  read: boolean
  createdAt: string
}

interface NotificationState {
  notifications: NotificationItem[]
  addNotification: (item: Omit<NotificationItem, 'id' | 'read' | 'createdAt'>) => void
  markRead: (id: string) => void
  markAllRead: () => void
  clearAll: () => void
}

export const useNotificationStore = create<NotificationState>()(
  persist(
    (set) => ({
      notifications: [],
      addNotification: (item) =>
        set((state) => ({
          notifications: [
            {
              id: crypto.randomUUID(),
              ...item,
              read: false,
              createdAt: new Date().toISOString(),
            },
            ...state.notifications,
          ].slice(0, 100),
        })),
      markRead: (id) =>
        set((state) => ({
          notifications: state.notifications.map((n) =>
            n.id === id ? { ...n, read: true } : n,
          ),
        })),
      markAllRead: () =>
        set((state) => ({
          notifications: state.notifications.map((n) => ({ ...n, read: true })),
        })),
      clearAll: () => set({ notifications: [] }),
    }),
    { name: 'life-os:notifications' },
  ),
)
