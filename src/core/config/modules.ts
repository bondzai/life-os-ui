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
  BarChart3,
  GitBranch,
  CalendarPlus,
  FolderKanban,
  GanttChart,
  Zap,
  Sparkles,
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
  { id: 'lyra', label: 'Lyra', icon: Sparkles, path: '/lyra', group: 'Daily', entityTypes: [] },


  // Plan — strategic tools & review cycles
  { id: 'tasks', label: 'Tasks', icon: CheckSquare, path: '/tasks', group: 'Plan', entityTypes: ['task'] },
  { id: 'projects', label: 'Projects', icon: FolderKanban, path: '/projects', group: 'Plan', entityTypes: ['project'] },
  { id: 'gantt', label: 'Timeline', icon: GanttChart, path: '/gantt', group: 'Plan', entityTypes: [] },
  {
    id: 'calendar', label: 'Calendar', icon: Calendar, path: '/calendar', group: 'Plan', entityTypes: ['event'],
    children: [
      { id: 'events', label: 'Events', icon: CalendarPlus, path: '/events' },
    ],
  },
  {
    id: 'notes', label: 'Notes', icon: NotebookPen, path: '/notes', group: 'Plan', entityTypes: ['note'],
    children: [
      { id: 'note-map', label: 'Note Map', icon: GitBranch, path: '/note-map' },
    ],
  },
  {
    id: 'goals', label: 'Goals', icon: Target, path: '/goals', group: 'Plan', entityTypes: ['goal'],
    children: [
      { id: 'goal-map', label: 'Goal Map', icon: GitBranch, path: '/goal-map' },
    ],
  },
  { id: 'habits', label: 'Habits', icon: Repeat, path: '/habits', group: 'Plan', entityTypes: ['habit'] },
  { id: 'skills', label: 'Skills', icon: Zap, path: '/skills', group: 'Plan', entityTypes: ['skill'] },

  // Life — domains you track
  { id: 'health', label: 'Health', icon: Heart, path: '/health', group: 'Life', entityTypes: ['body-metric', 'workout', 'sleep-mood'] },
  { id: 'wealth', label: 'Wealth', icon: Wallet, path: '/wealth', group: 'Life', entityTypes: ['transaction', 'budget', 'account', 'asset', 'wallet', 'crypto-tx'] },
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
