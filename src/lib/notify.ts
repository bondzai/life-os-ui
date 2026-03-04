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

export function notifyWithUndo(title: string, onUndo: () => void) {
  toast.success(title, {
    action: { label: 'Undo', onClick: onUndo },
    duration: 5000,
  })
  useNotificationStore.getState().addNotification({ title, type: 'success' })
}
