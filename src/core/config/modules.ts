import {
  BarChart3,
  BellRing,
  Bitcoin,
  BookOpen,
  Bot,
  Calendar,
  CheckSquare,
  ClipboardCheck,
  FolderKanban,
  Inbox,
  Layers,
  LayoutDashboard,
  NotebookPen,
  Repeat,
  SlidersHorizontal,
  Target,
  Telescope,
  Timer,
  Wallet,
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
  /**
   * The letter that follows `g` to jump here — `g t` for Tasks, the way Linear and GitHub do it.
   *
   * On the module rather than in a table of its own, so a new module cannot be added without a
   * key or given one that silently collides; [[goKeyIndex]] asserts that at startup.
   */
  goKey: string
  group: string
  entityTypes: EntityType[]
  children?: SubModuleConfig[]
}

/**
 * The sidebar, grouped by **rhythm** rather than by category.
 *
 * It used to be Daily (2) and Plan (9), which put nine of the eleven entries under one heading —
 * a grouping that sorts nothing is a heading you stop reading. Now / Plan / Money is three
 * questions instead: what am I doing right now, what am I working towards, where is the money.
 *
 * Two routes that existed but were not listed are now listed. Inbox was reachable only through a
 * link buried inside a Focus panel, and Deep Work only through ⌘⇧D — both are places you go on
 * purpose, and a route nothing points at is a feature you have to remember you own.
 *
 * Knowledge is gone from here on purpose: it configures the AI's persona, agents and context,
 * which is configuration, not a plan. It lives under Settings now, and keeps its route.
 */
export const modules: ModuleConfig[] = [
  // Now — the three places you work from
  { id: 'focus', label: 'Focus', icon: LayoutDashboard, path: '/', goKey: 'f', group: 'Now', entityTypes: [] },
  { id: 'deep-work', label: 'Deep Work', icon: Timer, path: '/deep-work', goKey: 'd', group: 'Now', entityTypes: [] },
  { id: 'inbox', label: 'Inbox', icon: Inbox, path: '/inbox', goKey: 'i', group: 'Now', entityTypes: [] },
  { id: 'agents', label: 'Agents', icon: Bot, path: '/agents', goKey: 'a', group: 'Now', entityTypes: [] },

  // Plan — what you are working towards, and the surfaces that review it
  { id: 'tasks', label: 'Tasks', icon: CheckSquare, path: '/tasks', goKey: 't', group: 'Plan', entityTypes: ['task', 'chore'] },
  { id: 'projects', label: 'Projects', icon: FolderKanban, path: '/projects', goKey: 'p', group: 'Plan', entityTypes: ['project'] },
  { id: 'goals', label: 'Goals', icon: Target, path: '/goals', goKey: 'g', group: 'Plan', entityTypes: ['goal'] },
  { id: 'calendar', label: 'Calendar', icon: Calendar, path: '/calendar', goKey: 'c', group: 'Plan', entityTypes: ['event'] },
  { id: 'habits', label: 'Habits', icon: Repeat, path: '/habits', goKey: 'h', group: 'Plan', entityTypes: ['habit'] },
  { id: 'notes', label: 'Notes', icon: NotebookPen, path: '/notes', goKey: 'n', group: 'Plan', entityTypes: ['note'] },
  { id: 'review', label: 'Review', icon: ClipboardCheck, path: '/review', goKey: 'r', group: 'Plan', entityTypes: [] },
  // A trend surface, not a daily one — it answers "how is the quarter going", which is a question
  // you ask next to Review rather than at 9am.
  { id: 'dashboard', label: 'Dashboard', icon: BarChart3, path: '/dashboard', goKey: 'b', group: 'Plan', entityTypes: [] },

  // Money — the crypto portfolio surfaces. Sub-routes are lazy; see App.tsx.
  {
    id: 'wealth',
    label: 'Wealth',
    icon: Wallet,
    path: '/wealth',
    goKey: 'w',
    group: 'Money',
    entityTypes: ['wallet', 'asset', 'crypto-tx', 'account'],
    children: [
      { id: 'wealth-holdings', label: 'Holdings', icon: Wallet, path: '/wealth/holdings' },
      { id: 'wealth-defi', label: 'DeFi', icon: Layers, path: '/wealth/defi' },
      { id: 'wealth-opportunities', label: 'Opportunities', icon: Telescope, path: '/wealth/opportunities' },
      { id: 'wealth-btc', label: 'BTC', icon: Bitcoin, path: '/wealth/btc' },
      { id: 'wealth-bots', label: 'Bots', icon: Bot, path: '/wealth/bots' },
      { id: 'wealth-journal', label: 'Journal', icon: BookOpen, path: '/wealth/journal' },
      { id: 'wealth-settings', label: 'Settings', icon: SlidersHorizontal, path: '/wealth/settings' },
      { id: 'wealth-alerts', label: 'Alerts', icon: BellRing, path: '/wealth/alerts' },
    ],
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

/** Groups that should be collapsed by default */
export const DEFAULT_COLLAPSED_GROUPS: Record<string, boolean> = {}

/**
 * `g`-key → module, built once and checked as it is built.
 *
 * A duplicate key is a module you can never reach by keyboard, and it fails silently: the first
 * one wins and the second simply never fires. Cheaper to throw here, at import, than to wonder in
 * six months why `g p` stopped going to Projects.
 */
export const goKeyIndex: Record<string, ModuleConfig> = (() => {
  const index: Record<string, ModuleConfig> = {}
  for (const mod of modules) {
    if (index[mod.goKey]) {
      throw new Error(`Duplicate module goKey "${mod.goKey}": ${index[mod.goKey].id} and ${mod.id}`)
    }
    index[mod.goKey] = mod
  }
  return index
})()
