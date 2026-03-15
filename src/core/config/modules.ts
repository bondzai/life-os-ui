import {
  Target,
  CheckSquare,
  Calendar,
  Repeat,
  GraduationCap,
  Heart,
  Wallet,
  Users,
  NotebookPen,
  MapPin,
  LayoutDashboard,
  ClipboardCheck,
  BarChart3,
  Timer,
  type LucideIcon,
} from 'lucide-react'
import type { EntityType } from '@/core/types'

export interface ModuleConfig {
  id: string
  label: string
  icon: LucideIcon
  path: string
  group: string
  entityTypes: EntityType[]
}

export const modules: ModuleConfig[] = [
  // Core — daily drivers
  { id: 'focus', label: 'Focus', icon: LayoutDashboard, path: '/', group: 'Core', entityTypes: [] },
  { id: 'deep-work', label: 'Deep Work', icon: Timer, path: '/deep-work', group: 'Core', entityTypes: [] },
  { id: 'dashboard', label: 'Dashboard', icon: BarChart3, path: '/dashboard', group: 'Core', entityTypes: [] },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare, path: '/tasks', group: 'Core', entityTypes: ['task'] },
  { id: 'notes', label: 'Notes', icon: NotebookPen, path: '/notes', group: 'Core', entityTypes: ['note'] },
  { id: 'calendar', label: 'Calendar', icon: Calendar, path: '/calendar', group: 'Core', entityTypes: ['event'] },

  // Track — goals & measurement
  { id: 'goals', label: 'Goals', icon: Target, path: '/goals', group: 'Track', entityTypes: ['goal'] },
  { id: 'habits', label: 'Habits', icon: Repeat, path: '/habits', group: 'Track', entityTypes: ['habit'] },
  { id: 'health', label: 'Health', icon: Heart, path: '/health', group: 'Track', entityTypes: ['body-metric', 'workout', 'sleep-mood'] },
  { id: 'wealth', label: 'Wealth', icon: Wallet, path: '/wealth', group: 'Track', entityTypes: ['transaction', 'budget', 'account', 'asset', 'wallet', 'crypto-tx'] },

  // Life — lifestyle
  { id: 'learning', label: 'Learning', icon: GraduationCap, path: '/learning', group: 'Life', entityTypes: ['book', 'course', 'skill'] },
  { id: 'travel', label: 'Travel', icon: MapPin, path: '/travel', group: 'Life', entityTypes: ['place', 'location', 'trip'] },
  { id: 'family', label: 'Family', icon: Users, path: '/family', group: 'Life', entityTypes: ['chore'] },
  { id: 'review', label: 'Review', icon: ClipboardCheck, path: '/review', group: 'Life', entityTypes: [] },
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
