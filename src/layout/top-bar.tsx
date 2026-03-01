import { MessageSquare, Search } from 'lucide-react'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { Separator } from '@/components/ui/separator'
import { Button } from '@/components/ui/button'
import { useChatStore } from '@/stores/chat-store'
import { useUiStore } from '@/stores/ui-store'

interface TopBarProps {
  title: string
}

export function TopBar({ title }: TopBarProps) {
  const toggleChat = useChatStore((s) => s.toggleOpen)
  const setCommandBarOpen = useUiStore((s) => s.setCommandBarOpen)

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
      <Button variant="ghost" size="icon" className="h-8 w-8" onClick={toggleChat}>
        <MessageSquare className="h-4 w-4" />
      </Button>
    </header>
  )
}
