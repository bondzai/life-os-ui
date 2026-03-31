import { useEffect, useState, Suspense } from 'react'
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
import { useFocusStore } from '@/stores/focus-store'
import { LyraPageLoader } from '@/components/lyra-loader'
import { useLyraPulse } from '@/hooks/use-lyra-pulse'
import { useSessionSummary } from '@/hooks/use-session-summary'
import { useCelebrations } from '@/hooks/use-celebrations'

function getPageTitle(pathname: string): string {
  const mod = modules.find((m) => m.path === pathname)
  return mod?.label ?? 'Lyra'
}

function useClock() {
  const [now, setNow] = useState(new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000)
    return () => clearInterval(id)
  }, [])
  return now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

export function AppLayout() {
  useLyraPulse() // Lyra background heartbeat
  useSessionSummary()
  useCelebrations()
  const location = useLocation()
  const title = getPageTitle(location.pathname)
  const setCommandBarOpen = useUiStore((s) => s.setCommandBarOpen)
  const focusMode = useUiStore((s) => s.focusMode)
  const toggleFocusMode = useUiStore((s) => s.toggleFocusMode)
  const clock = useClock()

  // Browser tab title — show focus timer when session is active
  const focusSessionActive = useFocusStore((s) => !!s.sessionId && s.emperorEntityIds.length > 0)
  const focusSeconds = useFocusStore((s) => s.secondsLeft)
  const focusPhase = useFocusStore((s) => s.phase)

  useEffect(() => {
    if (location.pathname === '/deep-work') return // deep-work page manages its own title
    if (focusSessionActive && focusSeconds > 0) {
      const m = Math.floor(focusSeconds / 60)
      const s = String(focusSeconds % 60).padStart(2, '0')
      const label = focusPhase === 'break' || focusPhase === 'long-break' ? 'Break' : 'Focus'
      document.title = `${m}:${s} ${label} — Lyra`
    } else {
      document.title = 'Lyra'
    }
  }, [focusSessionActive, focusSeconds, focusPhase, location.pathname])

  // Global Cmd+K and Cmd+Shift+F listeners
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCommandBarOpen(true)
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'f') {
        // Don't toggle when typing in an input
        const tag = (e.target as HTMLElement)?.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target as HTMLElement)?.isContentEditable) return
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
              fallback={<LyraPageLoader />}
            >
              <Outlet />
            </Suspense>
          </div>
        </main>
      </div>
      <ChatSidebar />
      <CommandBar />
      <InboxCapture />

      {/* Focus mode: floating bar with clock + timer + page + exit */}
      {focusMode ? (
        <div className="fixed top-3 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 bg-background/80 backdrop-blur-sm border rounded-full shadow-md px-4 py-1.5 opacity-0 hover:opacity-100 transition-opacity">
          <span className="text-xs tabular-nums text-muted-foreground font-medium">{clock}</span>
          {focusSessionActive && focusSeconds > 0 && (
            <>
              <span className="w-px h-3 bg-border" />
              <span className={`text-xs tabular-nums font-medium ${focusPhase === 'work' ? 'text-amber-500' : 'text-emerald-500'}`}>
                {Math.floor(focusSeconds / 60)}:{String(focusSeconds % 60).padStart(2, '0')}
              </span>
            </>
          )}
          <span className="w-px h-3 bg-border" />
          <span className="text-xs font-medium">{title}</span>
          <span className="w-px h-3 bg-border" />
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 cursor-pointer"
            onClick={toggleFocusMode}
            title="Exit Focus Mode (⌘⇧F)"
          >
            <EyeOff className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <Button
          variant="ghost"
          size="icon"
          className="fixed bottom-4 right-4 z-50 h-8 w-8 rounded-full shadow-md border bg-background/80 backdrop-blur-sm opacity-0 hover:opacity-100 transition-opacity cursor-pointer"
          onClick={toggleFocusMode}
          title="Enter Focus Mode (⌘⇧F)"
        >
          <Eye className="h-4 w-4" />
        </Button>
      )}
    </SidebarProvider>
  )
}
