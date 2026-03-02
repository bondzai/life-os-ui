import { Bell, CheckCheck, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useNotificationStore } from '@/stores/notification-store'
import { EmptyState } from '@/core/components/empty-state'

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const seconds = Math.floor(diff / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'Yesterday'
  return new Date(iso).toLocaleDateString()
}

export function NotificationsPage() {
  const notifications = useNotificationStore((s) => s.notifications)
  const markRead = useNotificationStore((s) => s.markRead)
  const markAllRead = useNotificationStore((s) => s.markAllRead)
  const clearAll = useNotificationStore((s) => s.clearAll)

  const unreadCount = notifications.filter((n) => !n.read).length

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-sm text-muted-foreground">
          {unreadCount} unread notification{unreadCount !== 1 ? 's' : ''}
        </p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={markAllRead} disabled={unreadCount === 0}>
            <CheckCheck className="h-4 w-4 mr-1" /> Mark all read
          </Button>
          <Button size="sm" variant="outline" onClick={clearAll} disabled={notifications.length === 0}>
            <Trash2 className="h-4 w-4 mr-1" /> Clear all
          </Button>
        </div>
      </div>

      {/* Notification list */}
      {notifications.length === 0 ? (
        <EmptyState
          icon={Bell}
          title="No notifications"
          description="Notifications from your actions will appear here."
        />
      ) : (
        <div className="space-y-2">
          {notifications.map((n) => (
            <Card
              key={n.id}
              className={!n.read ? 'border-primary/40' : ''}
            >
              <CardContent className="flex items-start justify-between py-3 gap-3">
                <div className="flex-1 space-y-0.5">
                  <p className={`text-sm ${!n.read ? 'font-semibold' : ''}`}>{n.title}</p>
                  {n.message && (
                    <p className="text-xs text-muted-foreground">{n.message}</p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {formatRelativeTime(n.createdAt)}
                  </p>
                </div>
                {!n.read && (
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => markRead(n.id)}>
                    Mark read
                  </Button>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
