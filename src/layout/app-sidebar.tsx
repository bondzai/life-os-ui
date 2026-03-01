import { useLocation, useNavigate } from 'react-router'
import { LogOut } from 'lucide-react'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
} from '@/components/ui/sidebar'
import { ModeToggle } from '@/components/mode-toggle'
import { useAuthStore } from '@/stores/auth-store'
import { getModuleGroups } from '@/core/config/modules'

export function AppSidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { currentUser, logout } = useAuthStore()
  const groups = getModuleGroups()

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  return (
    <Sidebar>
      <SidebarHeader className="p-4">
        <h1 className="text-lg font-bold tracking-tight">Life-OS</h1>
      </SidebarHeader>
      <SidebarContent>
        {groups.map(({ group, modules }) => (
          <SidebarGroup key={group}>
            <SidebarGroupLabel>{group}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {modules.map((mod) => (
                  <SidebarMenuItem key={mod.id}>
                    <SidebarMenuButton
                      isActive={location.pathname === mod.path}
                      onClick={() => navigate(mod.path)}
                    >
                      <mod.icon className="h-4 w-4" />
                      <span>{mod.label}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter className="p-4">
        <SidebarSeparator />
        <div className="flex items-center justify-between pt-2">
          <div className="flex items-center gap-2">
            <div className="h-7 w-7 rounded-full bg-primary flex items-center justify-center text-xs text-primary-foreground font-medium">
              {currentUser?.name?.charAt(0) ?? '?'}
            </div>
            <span className="text-sm font-medium">{currentUser?.name}</span>
          </div>
          <div className="flex items-center gap-1">
            <ModeToggle />
            <SidebarMenuButton onClick={handleLogout} className="w-auto px-2">
              <LogOut className="h-4 w-4" />
            </SidebarMenuButton>
          </div>
        </div>
      </SidebarFooter>
    </Sidebar>
  )
}
