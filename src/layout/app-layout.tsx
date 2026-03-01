import { Outlet, useLocation } from 'react-router'
import { SidebarProvider } from '@/components/ui/sidebar'
import { AppSidebar } from './app-sidebar'
import { TopBar } from './top-bar'
import { modules } from '@/core/config/modules'

function getPageTitle(pathname: string): string {
  const mod = modules.find((m) => m.path === pathname)
  return mod?.label ?? 'Life-OS'
}

export function AppLayout() {
  const location = useLocation()
  const title = getPageTitle(location.pathname)

  return (
    <SidebarProvider>
      <div className="flex min-h-screen w-full">
        <AppSidebar />
        <main className="flex-1 flex flex-col">
          <TopBar title={title} />
          <div className="flex-1 p-6">
            <Outlet />
          </div>
        </main>
      </div>
    </SidebarProvider>
  )
}
