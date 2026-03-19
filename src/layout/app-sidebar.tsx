import { useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { LogOut, Download, Upload, Settings, Crown, ChevronRight } from 'lucide-react'
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
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarSeparator,
  useSidebar,
} from '@/components/ui/sidebar'
import { ModeToggle } from '@/components/mode-toggle'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useAuthStore } from '@/stores/auth-store'
import { useFocusStore } from '@/stores/focus-store'
import { useEntities } from '@/core/hooks'
import { getModuleGroups, DEFAULT_COLLAPSED_GROUPS } from '@/core/config/modules'
import { exportData, importData } from '@/lib/data-backup'
import { notify } from '@/lib/notify'
import { SettingsDialog } from '@/components/settings-dialog'

const COLLAPSED_KEY = 'lyra:sidebar-collapsed'
const EXPANDED_SUBS_KEY = 'lyra:sidebar-expanded-subs'

function getCollapsed(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(COLLAPSED_KEY)
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return { ...DEFAULT_COLLAPSED_GROUPS }
}

function setCollapsed(state: Record<string, boolean>) {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(state))
}

function getExpandedSubs(): Record<string, boolean> {
  try {
    const stored = localStorage.getItem(EXPANDED_SUBS_KEY)
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return {}
}

function setExpandedSubs(state: Record<string, boolean>) {
  localStorage.setItem(EXPANDED_SUBS_KEY, JSON.stringify(state))
}

export function AppSidebar() {
  const location = useLocation()
  const navigate = useNavigate()
  const { currentUser, logout } = useAuthStore()
  const { isMobile, setOpenMobile } = useSidebar()
  const groups = getModuleGroups()
  const fileRef = useRef<HTMLInputElement>(null)

  const [collapsed, setCollapsedState] = useState<Record<string, boolean>>(() => getCollapsed())
  const [expandedSubs, setExpandedSubsState] = useState<Record<string, boolean>>(() => getExpandedSubs())
  const [changelogOpen, setChangelogOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Badge counts
  const { items: allEntities } = useEntities()
  const today = new Date().toISOString().split('T')[0]
  const dueTaskCount = allEntities.filter(
    (e) => e.type === 'task' && e.status !== 'done' && e.status !== 'archived' && e.dueDate && e.dueDate <= today,
  ).length
  const dueChoreCount = allEntities.filter(
    (e) => e.type === 'chore' && e.status !== 'done' && e.status !== 'archived' && e.dueDate && e.dueDate <= today,
  ).length

  const badges: Record<string, number> = {}
  if (dueTaskCount > 0) badges['tasks'] = dueTaskCount
  if (dueChoreCount > 0) badges['family'] = dueChoreCount

  // Active focus session detection
  const hasActiveSession = useFocusStore((s) => !!s.sessionId && s.emperorEntityIds.length > 0 && s.phase !== 'idle')

  const toggleGroup = (group: string) => {
    const next = { ...collapsed, [group]: !collapsed[group] }
    setCollapsedState(next)
    setCollapsed(next)
  }

  const toggleSub = (modId: string) => {
    const next = { ...expandedSubs, [modId]: !expandedSubs[modId] }
    setExpandedSubsState(next)
    setExpandedSubs(next)
  }

  const isSubExpanded = (modId: string) => {
    // Explicitly toggled state takes priority
    if (expandedSubs[modId] !== undefined) return expandedSubs[modId]
    // Default: expanded if current route is the parent or a child
    return true
  }

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const { count, migrated } = await importData(file)
      const msg = migrated
        ? `Imported ${count} data sets (migrated from older version).`
        : `Imported ${count} data sets.`
      notify({ title: 'Import complete', message: msg, type: 'success' })
      window.location.reload()
    } catch {
      notify({ title: 'Import failed', message: 'Invalid backup file.', type: 'error' })
    }
    e.target.value = ''
  }

  const handleNav = (path: string) => {
    navigate(path)
    if (isMobile) setOpenMobile(false)
  }

  return (
    <Sidebar>
      <SidebarHeader className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <div className="h-8 w-8 rounded-lg flex items-center justify-center shrink-0" style={{ background: '#0f172a' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <g stroke="#94a3b8" strokeWidth="0.6" opacity="0.4">
                <line x1="12" y1="3" x2="8.5" y2="7.5"/>
                <line x1="12" y1="3" x2="15.5" y2="7.5"/>
                <line x1="8.5" y1="7.5" x2="8" y2="14"/>
                <line x1="15.5" y1="7.5" x2="16" y2="14"/>
                <line x1="8" y1="14" x2="9.5" y2="19.5"/>
                <line x1="16" y1="14" x2="14.5" y2="19.5"/>
                <line x1="9.5" y1="19.5" x2="14.5" y2="19.5"/>
              </g>
              <circle cx="12" cy="3" r="1.8" fill="#60a5fa"/>
              <circle cx="8.5" cy="7.5" r="1.2" fill="#e2e8f0"/>
              <circle cx="15.5" cy="7.5" r="1.2" fill="#e2e8f0"/>
              <circle cx="8" cy="14" r="1" fill="#e2e8f0" opacity="0.8"/>
              <circle cx="16" cy="14" r="1" fill="#e2e8f0" opacity="0.8"/>
              <circle cx="9.5" cy="19.5" r="0.8" fill="#e2e8f0" opacity="0.6"/>
              <circle cx="14.5" cy="19.5" r="0.8" fill="#e2e8f0" opacity="0.6"/>
            </svg>
          </div>
          <div className="flex items-baseline gap-1.5">
            <h1 className="text-lg font-bold tracking-tight">Lyra</h1>
            <button
              onClick={() => setChangelogOpen(true)}
              className="text-[10px] font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              v{APP_VERSION}
            </button>
          </div>
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
                <SidebarGroupLabel className="cursor-pointer select-none group/label">
                  <span className="flex-1">{group}</span>
                  <ChevronRight className={`h-3 w-3 text-muted-foreground/50 transition-transform duration-200 group-hover/label:text-muted-foreground ${!collapsed[group] ? 'rotate-90' : ''}`} />
                </SidebarGroupLabel>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <SidebarGroupContent>
                  <SidebarMenu>
                    {/* Paused focus session reminder — always first */}
                    {group === 'Core' && hasActiveSession && location.pathname !== '/deep-work' && (
                      <SidebarMenuItem>
                        <SidebarMenuButton
                          onClick={() => handleNav('/deep-work')}
                          className="group/focus relative bg-amber-500/5 hover:bg-amber-500/10 border border-amber-500/15 rounded-md"
                        >
                          <span className="relative flex h-4 w-4 items-center justify-center">
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-40" />
                            <Crown className="relative h-3.5 w-3.5 text-amber-500" />
                          </span>
                          <span className="flex-1 text-amber-600 dark:text-amber-400 font-medium">Resume Focus</span>
                          <span className="text-[10px] text-amber-500/60">Paused</span>
                        </SidebarMenuButton>
                      </SidebarMenuItem>
                    )}
                    {mods.map((mod) => {
                      const isActive = location.pathname === mod.path
                      const hasChildren = mod.children && mod.children.length > 0
                      const subOpen = hasChildren && isSubExpanded(mod.id)

                      return (
                        <Collapsible
                          key={mod.id}
                          open={subOpen}
                          onOpenChange={() => hasChildren && toggleSub(mod.id)}
                          asChild
                        >
                          <SidebarMenuItem>
                            <SidebarMenuButton
                              isActive={isActive}
                              onClick={() => handleNav(mod.path)}
                            >
                              <mod.icon className="h-4 w-4" />
                              <span className="flex-1">{mod.label}</span>
                              {badges[mod.id] ? (
                                <span className="ml-auto text-xs bg-destructive text-destructive-foreground rounded-full w-5 h-5 flex items-center justify-center">
                                  {badges[mod.id]}
                                </span>
                              ) : null}
                            </SidebarMenuButton>
                            {hasChildren && (
                              <CollapsibleTrigger asChild>
                                <button
                                  className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded-md text-muted-foreground/40 hover:text-muted-foreground hover:bg-accent/50 transition-colors"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <ChevronRight className={`h-3.5 w-3.5 transition-transform duration-200 ${subOpen ? 'rotate-90' : ''}`} />
                                </button>
                              </CollapsibleTrigger>
                            )}
                            {hasChildren && (
                              <CollapsibleContent>
                                <SidebarMenuSub>
                                  {mod.children!.map((child) => (
                                    <SidebarMenuSubItem key={child.id}>
                                      <SidebarMenuSubButton
                                        isActive={location.pathname === child.path}
                                        onClick={() => handleNav(child.path)}
                                      >
                                        <child.icon className="h-3.5 w-3.5" />
                                        <span>{child.label}</span>
                                      </SidebarMenuSubButton>
                                    </SidebarMenuSubItem>
                                  ))}
                                </SidebarMenuSub>
                              </CollapsibleContent>
                            )}
                          </SidebarMenuItem>
                        </Collapsible>
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
            <SidebarMenuButton onClick={() => setSettingsOpen(true)} className="w-auto px-2">
              <Settings className="h-4 w-4" />
            </SidebarMenuButton>
            <SidebarMenuButton onClick={handleLogout} className="w-auto px-2">
              <LogOut className="h-4 w-4" />
            </SidebarMenuButton>
          </div>
        </div>
      </SidebarFooter>
      <ChangelogDialog open={changelogOpen} onOpenChange={setChangelogOpen} />
      <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
    </Sidebar>
  )
}
