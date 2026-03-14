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
  // Core — daily drivers
  { id: 'today', label: 'Today', icon: Sun, path: '/', group: 'Core', entityTypes: [] },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare, path: '/tasks', group: 'Core', entityTypes: ['task'] },
  { id: 'notes', label: 'Notes', icon: NotebookPen, path: '/notes', group: 'Core', entityTypes: ['note'] },
  { id: 'calendar', label: 'Calendar', icon: Calendar, path: '/calendar', group: 'Core', entityTypes: ['event'] },
  { id: 'location', label: 'Location', icon: MapPin, path: '/location', group: 'Core', entityTypes: ['location'] },

  // Track — goals & measurement
  { id: 'goals', label: 'Goals', icon: Target, path: '/goals', group: 'Track', entityTypes: ['goal'] },
  { id: 'habits', label: 'Habits', icon: Repeat, path: '/habits', group: 'Track', entityTypes: ['habit'] },
  { id: 'health', label: 'Health', icon: Heart, path: '/health', group: 'Track', entityTypes: ['body-metric', 'workout', 'sleep-mood'] },
  { id: 'wealth', label: 'Wealth', icon: Wallet, path: '/wealth', group: 'Track', entityTypes: ['transaction', 'budget', 'account', 'asset', 'wallet', 'crypto-tx'] },

  // More — everything else
  { id: 'skills', label: 'Skills', icon: Brain, path: '/skills', group: 'More', entityTypes: ['skill'] },
  { id: 'reading', label: 'Reading', icon: BookOpen, path: '/reading', group: 'More', entityTypes: ['book', 'course'] },
  { id: 'memories', label: 'Memories', icon: Camera, path: '/memories', group: 'More', entityTypes: ['memory'] },
  { id: 'posts', label: 'Posts', icon: Newspaper, path: '/posts', group: 'More', entityTypes: ['post'] },
  { id: 'places', label: 'Places', icon: MapPin, path: '/places', group: 'More', entityTypes: ['place'] },
  { id: 'travel', label: 'Travel', icon: Plane, path: '/travel', group: 'More', entityTypes: ['trip'] },
  { id: 'home', label: 'Home', icon: Home, path: '/home', group: 'More', entityTypes: ['device', 'service'] },
  { id: 'family', label: 'Family', icon: Users, path: '/family', group: 'More', entityTypes: ['chore'] },
  { id: 'automate', label: 'Automate', icon: Zap, path: '/automate', group: 'More', entityTypes: ['automation'] },
  { id: 'notifications', label: 'Notifications', icon: Bell, path: '/notifications', group: 'More', entityTypes: [] },
  { id: 'review', label: 'Review', icon: ClipboardCheck, path: '/review', group: 'More', entityTypes: [] },
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
export const DEFAULT_COLLAPSED_GROUPS: Record<string, boolean> = {
  More: true,
}
