import {
  Target,
  CheckSquare,
  Calendar,
  Repeat,
  NotebookPen,
  LayoutDashboard,
  BarChart3,
  ClipboardCheck,
  type LucideIcon,
} from 'lucide-react'
import type { EntityType } from '@/core/types'

export interface SubModuleConfig {
  id: string
  label: string
  icon: LucideIcon
  path: string
}

export interface ModuleConfig {
  id: string
  label: string
  icon: LucideIcon
  path: string
  group: string
  entityTypes: EntityType[]
  children?: SubModuleConfig[]
}

export const modules: ModuleConfig[] = [
  // Daily — what you open every day
  { id: 'focus', label: 'Focus', icon: LayoutDashboard, path: '/', group: 'Daily', entityTypes: [] },
  { id: 'dashboard', label: 'Dashboard', icon: BarChart3, path: '/dashboard', group: 'Daily', entityTypes: [] },

  // Plan — strategic tools & review cycles
  { id: 'tasks', label: 'Tasks', icon: CheckSquare, path: '/tasks', group: 'Plan', entityTypes: ['task', 'chore'] },
  { id: 'goals', label: 'Goals', icon: Target, path: '/goals', group: 'Plan', entityTypes: ['goal', 'project'] },
  { id: 'calendar', label: 'Calendar', icon: Calendar, path: '/calendar', group: 'Plan', entityTypes: ['event'] },
  { id: 'notes', label: 'Notes', icon: NotebookPen, path: '/notes', group: 'Plan', entityTypes: ['note'] },
  { id: 'habits', label: 'Habits', icon: Repeat, path: '/habits', group: 'Plan', entityTypes: ['habit'] },
  { id: 'review', label: 'Review', icon: ClipboardCheck, path: '/review', group: 'Plan', entityTypes: [] },
]

export function getModuleGroups(): { group: string; modules: ModuleConfig[] }[] {
  const groups: Map<string, ModuleConfig[]> = new Map()
  for (const mod of modules) {
    const list = groups.get(mod.group) ?? []
    list.push(mod)
    groups.set(mod.group, list)
  }
  return Array.from(groups.entries()).map(([group, mods]) => ({ group, modules: mods }))
}

/** Groups that should be collapsed by default */
export const DEFAULT_COLLAPSED_GROUPS: Record<string, boolean> = {}
