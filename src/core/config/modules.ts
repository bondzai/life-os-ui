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
  Inbox,
  FileText,
  BarChart3,
  GitBranch,
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
  // Command — strategic cockpit
  {
    id: 'focus', label: 'Focus', icon: LayoutDashboard, path: '/', group: 'Command', entityTypes: [],
    children: [
      { id: 'inbox', label: 'Inbox', icon: Inbox, path: '/inbox' },
      { id: 'report', label: 'Report', icon: FileText, path: '/report' },
      { id: 'review', label: 'Review', icon: ClipboardCheck, path: '/review' },
    ],
  },
  { id: 'dashboard', label: 'Dashboard', icon: BarChart3, path: '/dashboard', group: 'Command', entityTypes: [] },

  // Operate — daily tactical tools
  { id: 'tasks', label: 'Tasks', icon: CheckSquare, path: '/tasks', group: 'Operate', entityTypes: ['task'] },
  {
    id: 'notes', label: 'Notes', icon: NotebookPen, path: '/notes', group: 'Operate', entityTypes: ['note'],
    children: [
      { id: 'note-map', label: 'Note Map', icon: GitBranch, path: '/note-map' },
    ],
  },
  { id: 'calendar', label: 'Calendar', icon: Calendar, path: '/calendar', group: 'Operate', entityTypes: ['event'] },

  // Track — metrics & measurement
  {
    id: 'goals', label: 'Goals', icon: Target, path: '/goals', group: 'Track', entityTypes: ['goal'],
    children: [
      { id: 'goal-map', label: 'Goal Map', icon: GitBranch, path: '/goal-map' },
    ],
  },
  { id: 'habits', label: 'Habits', icon: Repeat, path: '/habits', group: 'Track', entityTypes: ['habit'] },
  { id: 'health', label: 'Health', icon: Heart, path: '/health', group: 'Track', entityTypes: ['body-metric', 'workout', 'sleep-mood'] },
  { id: 'wealth', label: 'Wealth', icon: Wallet, path: '/wealth', group: 'Track', entityTypes: ['transaction', 'budget', 'account', 'asset', 'wallet', 'crypto-tx'] },

  // Life — growth & lifestyle
  { id: 'learning', label: 'Learning', icon: GraduationCap, path: '/learning', group: 'Life', entityTypes: ['book', 'course', 'skill'] },
  { id: 'travel', label: 'Travel', icon: MapPin, path: '/travel', group: 'Life', entityTypes: ['place', 'location', 'trip'] },
  { id: 'family', label: 'Family', icon: Users, path: '/family', group: 'Life', entityTypes: ['chore'] },
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
