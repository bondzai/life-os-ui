import { useEffect, Suspense } from 'react'
import { Outlet, useLocation } from 'react-router'
import { SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'
import { TopBar } from './top-bar'
import { modules } from '@/core/config/modules'
import { ChatSidebar } from '@/pages/ai/chat-sidebar'
import { CommandBar } from '@/pages/ai/command-bar'
import { useUiStore } from '@/stores/ui-store'

function getPageTitle(pathname: string): string {
  const mod = modules.find((m) => m.path === pathname)
  return mod?.label ?? 'Life-OS'
}

export function AppLayout() {
  const location = useLocation()
  const title = getPageTitle(location.pathname)
  const setCommandBarOpen = useUiStore((s) => s.setCommandBarOpen)

  // Global Cmd+K listener
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault()
        setCommandBarOpen(true)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [setCommandBarOpen])

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <main className="flex-1 flex flex-col">
          <TopBar title={title} />
          <div className="flex-1 p-3 sm:p-6">
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
    </SidebarProvider>
  )
}
