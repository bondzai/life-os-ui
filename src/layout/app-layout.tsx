import { useEffect, Suspense } from 'react'
import { Outlet, useLocation } from 'react-router'
import { Eye, EyeOff } from 'lucide-react'
import { SidebarProvider } from '@/components/ui/sidebar'
import { Button } from '@/components/ui/button'
import { AppSidebar } from './app-sidebar'
import { TopBar } from './top-bar'
import { modules } from '@/core/config/modules'
import { ChatSidebar } from '@/pages/ai/chat-sidebar'
import { CommandBar } from '@/pages/ai/command-bar'
import { InboxCapture } from '@/components/inbox-capture'
import { useUiStore } from '@/stores/ui-store'

function getPageTitle(pathname: string): string {
  const mod = modules.find((m) => m.path === pathname)
  return mod?.label ?? 'Lyra'
}

export function AppLayout() {
  const location = useLocation()
  const title = getPageTitle(location.pathname)
  const setCommandBarOpen = useUiStore((s) => s.setCommandBarOpen)
  const focusMode = useUiStore((s) => s.focusMode)
  const toggleFocusMode = useUiStore((s) => s.toggleFocusMode)

  // Global Cmd+K and Cmd+Shift+F listeners
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCommandBarOpen(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
        e.preventDefault()
        toggleFocusMode()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [setCommandBarOpen, toggleFocusMode])

  return (
    <SidebarProvider open={focusMode ? false : undefined}>
      <div className="flex min-h-screen w-full">
        {!focusMode && <AppSidebar />}
        <main className="flex-1 flex flex-col">
          {!focusMode && <TopBar title={title} />}
          <div className={`flex-1 ${focusMode ? 'p-4 sm:p-8' : 'p-3 sm:p-6'}`}>
            <Suspense
              fallback={
                <div className="flex items-center justify-center py-20">
                  <div className="h-6 w-6 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                </div>
              }
            >
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
      <ChatSidebar />
      <CommandBar />
      <InboxCapture />

      {/* Focus mode toggle — always visible */}
      <Button
        variant="ghost"
        size="icon"
        className={`fixed bottom-4 right-4 z-50 h-8 w-8 rounded-full shadow-md border bg-background/80 backdrop-blur-sm transition-opacity ${
          focusMode ? 'opacity-100' : 'opacity-0 hover:opacity-100'
        }`}
        onClick={toggleFocusMode}
        title={focusMode ? 'Exit Focus Mode (⌘⇧F)' : 'Enter Focus Mode (⌘⇧F)'}
      >
        {focusMode ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </Button>
    </SidebarProvider>
  )
}
