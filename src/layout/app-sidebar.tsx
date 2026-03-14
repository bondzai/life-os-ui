import { useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { LogOut, Download, Upload } from 'lucide-react'
import { ChangelogDialog } from '@/components/changelog-dialog'
import { APP_VERSION } from '@/lib/changelog-data'
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
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useAuthStore } from '@/stores/auth-store'
import { useEntities } from '@/core/hooks'
import { getModuleGroups, DEFAULT_COLLAPSED_GROUPS } from '@/core/config/modules'
import { exportData, importData } from '@/lib/data-backup'
import { notify } from '@/lib/notify'

const COLLAPSED_KEY = 'life-os:sidebar-collapsed'

function getCollapsed(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(COLLAPSED_KEY)
    if (stored) return JSON.parse(stored)
  } catch {
    // ignore
  }
  return { ...DEFAULT_COLLAPSED_GROUPS }
}

function setCollapsed(state: Record<string, boolean>) {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(state))
}

export function AppSidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { currentUser, logout } = useAuthStore()
  const groups = getModuleGroups()
  const fileRef = useRef<HTMLInputElement>(null)

  const [collapsed, setCollapsedState] = useState<Record<string, boolean>>(() => getCollapsed())
  const [changelogOpen, setChangelogOpen] = useState(false)

  // Badge counts
  const { items: allEntities } = useEntities()
  const today = new Date().toISOString().split('T')[0]
  const dueTaskCount = allEntities.filter(
    (e) => e.type === 'task' && e.status !== 'completed' && e.status !== 'archived' && e.dueDate && e.dueDate <= today,
  ).length
  const dueChoreCount = allEntities.filter(
    (e) => e.type === 'chore' && e.status !== 'completed' && e.status !== 'archived' && e.dueDate && e.dueDate <= today,
  ).length

  const badges: Record<string, number> = {}
  if (dueTaskCount > 0) badges['tasks'] = dueTaskCount
  if (dueChoreCount > 0) badges['family'] = dueChoreCount

  const toggleGroup = (group: string) => {
    const next = { ...collapsed, [group]: !collapsed[group] }
    setCollapsedState(next)
    setCollapsed(next)
  }

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const { count } = await importData(file)
      notify({ title: `Imported ${count} data sets`, message: 'Reload the page to see changes.', type: 'success' })
      window.location.reload()
    } catch {
      notify({ title: 'Import failed', message: 'Invalid backup file.', type: 'error' })
    }
    e.target.value = ''
  }

  return (
    <Sidebar>
      <SidebarHeader className="p-4">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold tracking-tight">Life-OS</h1>
          <button
            onClick={() => setChangelogOpen(true)}
            className="text-[10px] font-medium text-muted-foreground bg-muted px-1.5 py-0.5 rounded-md hover:bg-accent hover:text-accent-foreground transition-colors"
          >
            v{APP_VERSION}
          </button>
        </div>
      </SidebarHeader>
      <SidebarContent>
        {groups.map(({ group, modules: mods }) => (
          <Collapsible
            key={group}
            open={!collapsed[group]}
            onOpenChange={() => toggleGroup(group)}
          >
            <SidebarGroup>
              <CollapsibleTrigger asChild>
                <SidebarGroupLabel className="cursor-pointer select-none">
                  {group}
                </SidebarGroupLabel>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {mods.map((mod) => {
                      const isActive = location.pathname === mod.path
                      return (
                        <SidebarMenuItem key={mod.id}>
                          <SidebarMenuButton
                            isActive={isActive}
                            onClick={() => navigate(mod.path)}
                          >
                            <mod.icon className="h-4 w-4" />
                            <span className="flex-1">{mod.label}</span>
                            {badges[mod.id] ? (
                              <span className="ml-auto text-xs bg-destructive text-destructive-foreground rounded-full w-5 h-5 flex items-center justify-center">
                                {badges[mod.id]}
                              </span>
                            ) : null}
                          </SidebarMenuButton>
                        </SidebarMenuItem>
                      )
                    })}
                  </SidebarMenu>
                </SidebarGroupContent>
              </CollapsibleContent>
            </SidebarGroup>
          </Collapsible>
        ))}
      </SidebarContent>
      <SidebarFooter className="p-4">
        <SidebarSeparator />
        <div className="flex gap-1 pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 h-7 text-xs"
            onClick={() => {
              exportData()
              notify({ title: 'Backup downloaded', type: 'success' })
            }}
          >
            <Download className="h-3.5 w-3.5 mr-1" /> Export
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="flex-1 h-7 text-xs"
            onClick={() => fileRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5 mr-1" /> Import
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json"
            className="hidden"
            onChange={handleImport}
          />
        </div>
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
      <ChangelogDialog open={changelogOpen} onOpenChange={setChangelogOpen} />
    </Sidebar>
  )
}
