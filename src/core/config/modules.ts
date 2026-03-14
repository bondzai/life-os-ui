import {
  Target,
  CheckSquare,
  Calendar,
  Brain,
  Repeat,
  BookOpen,
  Heart,
  Wallet,
  Home,
  Users,
  LayoutDashboard,
  NotebookPen,
  Newspaper,
  Bell,
  MapPin,
  Plane,
  Zap,
  Camera,
  Sun,
  ClipboardCheck,
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
  // Focus — daily drivers
  {
    id: 'today',
    label: 'Today',
    icon: Sun,
    path: '/today',
    group: 'Focus',
    entityTypes: [],
  },
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    path: '/',
    group: 'Focus',
    entityTypes: [],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    icon: Calendar,
    path: '/calendar',
    group: 'Focus',
    entityTypes: ['event'],
  },
  // Life — core productivity
  {
    id: 'goals',
    label: 'Goals',
    icon: Target,
    path: '/goals',
    group: 'Life',
    entityTypes: ['goal'],
  },
  {
    id: 'tasks',
    label: 'Tasks',
    icon: CheckSquare,
    path: '/tasks',
    group: 'Life',
    entityTypes: ['task'],
  },
  {
    id: 'notes',
    label: 'Notes',
    icon: NotebookPen,
    path: '/notes',
    group: 'Life',
    entityTypes: ['note'],
  },
  {
    id: 'habits',
    label: 'Habits',
    icon: Repeat,
    path: '/habits',
    group: 'Life',
    entityTypes: ['habit'],
  },
  // Track — tracking modules
  {
    id: 'health',
    label: 'Health',
    icon: Heart,
    path: '/health',
    group: 'Track',
    entityTypes: ['body-metric', 'workout', 'sleep-mood'],
  },
  {
    id: 'wealth',
    label: 'Wealth',
    icon: Wallet,
    path: '/wealth',
    group: 'Track',
    entityTypes: ['transaction', 'budget', 'account', 'asset', 'wallet', 'crypto-tx'],
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: Brain,
    path: '/skills',
    group: 'Track',
    entityTypes: ['skill'],
  },
  {
    id: 'reading',
    label: 'Reading',
    icon: BookOpen,
    path: '/reading',
    group: 'Track',
    entityTypes: ['book', 'course'],
  },
  // More — everything else, collapsed by default
  {
    id: 'memories',
    label: 'Memories',
    icon: Camera,
    path: '/memories',
    group: 'More',
    entityTypes: ['memory'],
  },
  {
    id: 'posts',
    label: 'Posts',
    icon: Newspaper,
    path: '/posts',
    group: 'More',
    entityTypes: ['post'],
  },
  {
    id: 'places',
    label: 'Places',
    icon: MapPin,
    path: '/places',
    group: 'More',
    entityTypes: ['place'],
  },
  {
    id: 'travel',
    label: 'Travel',
    icon: Plane,
    path: '/travel',
    group: 'More',
    entityTypes: ['trip'],
  },
  {
    id: 'home',
    label: 'Home',
    icon: Home,
    path: '/home',
    group: 'More',
    entityTypes: ['device', 'service'],
  },
  {
    id: 'family',
    label: 'Family',
    icon: Users,
    path: '/family',
    group: 'More',
    entityTypes: ['chore'],
  },
  {
    id: 'automate',
    label: 'Automate',
    icon: Zap,
    path: '/automate',
    group: 'More',
    entityTypes: ['automation'],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: Bell,
    path: '/notifications',
    group: 'More',
    entityTypes: [],
  },
  {
    id: 'review',
    label: 'Review',
    icon: ClipboardCheck,
    path: '/review',
    group: 'More',
    entityTypes: [],
  },
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

// --- Favorites ---

const FAVORITES_KEY = 'life-os:favorites'
const DEFAULT_FAVORITES = ['/', '/today', '/tasks', '/notes']

export function getFavorites(): string[] {
  try {
    const stored = localStorage.getItem(FAVORITES_KEY)
    if (stored) return JSON.parse(stored)
  } catch {
    // ignore
  }
  return DEFAULT_FAVORITES
}

export function setFavorites(paths: string[]) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(paths))
}

export function toggleFavorite(path: string): string[] {
  const current = getFavorites()
  const next = current.includes(path)
    ? current.filter((p) => p !== path)
    : [...current, path]
  setFavorites(next)
  return next
}

export function getFavoriteModules(favPaths: string[]): ModuleConfig[] {
  return favPaths
    .map((path) => modules.find((m) => m.path === path))
    .filter((m): m is ModuleConfig => !!m)
}

/** Groups that should be collapsed by default */
export const DEFAULT_COLLAPSED_GROUPS: Record<string, boolean> = {
  More: true,
}
