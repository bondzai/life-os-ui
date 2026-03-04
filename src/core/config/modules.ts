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
  {
    id: 'dashboard',
    label: 'Dashboard',
    icon: LayoutDashboard,
    path: '/',
    group: 'Overview',
    entityTypes: [],
  },
  {
    id: 'notifications',
    label: 'Notifications',
    icon: Bell,
    path: '/notifications',
    group: 'Overview',
    entityTypes: [],
  },
  {
    id: 'goals',
    label: 'Goals',
    icon: Target,
    path: '/goals',
    group: 'Plan',
    entityTypes: ['goal'],
  },
  {
    id: 'tasks',
    label: 'Tasks',
    icon: CheckSquare,
    path: '/tasks',
    group: 'Plan',
    entityTypes: ['task'],
  },
  {
    id: 'calendar',
    label: 'Calendar',
    icon: Calendar,
    path: '/calendar',
    group: 'Plan',
    entityTypes: ['event'],
  },
  {
    id: 'notes',
    label: 'Notes',
    icon: NotebookPen,
    path: '/notes',
    group: 'Capture',
    entityTypes: ['note'],
  },
  {
    id: 'memories',
    label: 'Memories',
    icon: Camera,
    path: '/memories',
    group: 'Capture',
    entityTypes: ['memory'],
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: Brain,
    path: '/skills',
    group: 'Grow',
    entityTypes: ['skill'],
  },
  {
    id: 'habits',
    label: 'Habits',
    icon: Repeat,
    path: '/habits',
    group: 'Grow',
    entityTypes: ['habit'],
  },
  {
    id: 'reading',
    label: 'Reading',
    icon: BookOpen,
    path: '/reading',
    group: 'Grow',
    entityTypes: ['book', 'course'],
  },
  {
    id: 'places',
    label: 'Places',
    icon: MapPin,
    path: '/places',
    group: 'Explore',
    entityTypes: ['place'],
  },
  {
    id: 'travel',
    label: 'Travel',
    icon: Plane,
    path: '/travel',
    group: 'Explore',
    entityTypes: ['trip'],
  },
  {
    id: 'health',
    label: 'Health',
    icon: Heart,
    path: '/health',
    group: 'Health',
    entityTypes: ['body-metric', 'workout', 'sleep-mood'],
  },
  {
    id: 'wealth',
    label: 'Wealth',
    icon: Wallet,
    path: '/wealth',
    group: 'Wealth',
    entityTypes: ['transaction', 'budget', 'account', 'asset', 'wallet', 'crypto-tx'],
  },
  {
    id: 'home',
    label: 'Home',
    icon: Home,
    path: '/home',
    group: 'Home',
    entityTypes: ['device', 'service'],
  },
  {
    id: 'automate',
    label: 'Automate',
    icon: Zap,
    path: '/automate',
    group: 'Automate',
    entityTypes: ['automation'],
  },
  {
    id: 'posts',
    label: 'Posts',
    icon: Newspaper,
    path: '/posts',
    group: 'Family',
    entityTypes: ['post'],
  },
  {
    id: 'family',
    label: 'Family',
    icon: Users,
    path: '/family',
    group: 'Family',
    entityTypes: ['chore'],
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
