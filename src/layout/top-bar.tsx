import { useNavigate } from 'react-router'
import { Bell, MessageSquare, Search } from 'lucide-react'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useChatStore } from '@/stores/chat-store'
import { useUiStore } from '@/stores/ui-store'
import { useNotificationStore } from '@/stores/notification-store'

interface TopBarProps {
  title: string
}

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

export function TopBar({ title }: TopBarProps) {
  const navigate = useNavigate()
  const toggleChat = useChatStore((s) => s.toggleOpen)
  const setCommandBarOpen = useUiStore((s) => s.setCommandBarOpen)
  const notifications = useNotificationStore((s) => s.notifications)
  const markRead = useNotificationStore((s) => s.markRead)

  const unreadCount = notifications.filter((n) => !n.read).length
  const latest = notifications.slice(0, 5)

  return (
    <header className="flex h-14 items-center gap-3 border-b px-4">
      <SidebarTrigger />
      <Separator orientation="vertical" className="h-5" />
      <h2 className="text-sm font-medium flex-1">{title}</h2>
      <Button
        variant="outline"
        size="sm"
        className="hidden sm:flex items-center gap-1.5 text-xs text-muted-foreground"
        onClick={() => setCommandBarOpen(true)}
      >
        <Search className="h-3.5 w-3.5" />
        Search
        <kbd className="ml-1 pointer-events-none inline-flex h-5 items-center rounded border bg-muted px-1 font-mono text-[10px] font-medium text-muted-foreground">
          ⌘K
        </kbd>
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon" className="relative h-8 w-8">
            <Bell className="h-4 w-4" />
            {unreadCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-medium text-destructive-foreground">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          {latest.length === 0 ? (
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              No notifications
            </div>
          ) : (
            <>
              {latest.map((n) => (
                <DropdownMenuItem
                  key={n.id}
                  className="flex flex-col items-start gap-0.5 px-3 py-2 cursor-pointer"
                  onClick={() => markRead(n.id)}
                >
                  <span className={`text-sm ${!n.read ? 'font-semibold' : ''}`}>
                    {n.title}
                  </span>
                  {n.message && (
                    <span className="text-xs text-muted-foreground line-clamp-1">
                      {n.message}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {formatRelativeTime(n.createdAt)}
                  </span>
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="justify-center text-sm cursor-pointer"
                onClick={() => navigate('/notifications')}
              >
                View all
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleChat}>
        <MessageSquare className="h-4 w-4" />
      </Button>
    </header>
  )
}
