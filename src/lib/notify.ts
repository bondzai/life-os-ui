import { toast } from 'sonner'
import { useNotificationStore, type NotificationType } from '@/stores/notification-store'

interface NotifyOptions {
  title: string
  message?: string
  type?: NotificationType
}

export function notify({ title, message, type = 'info' }: NotifyOptions) {
  toast[type](title, { description: message })
  useNotificationStore.getState().addNotification({ title, message, type })
}

