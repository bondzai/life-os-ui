import {
  Inbox,
  CheckSquare,
  Calendar,
  Repeat,
  Target,
  NotebookPen,
  ClipboardCheck,
  LayoutDashboard,
  Settings2,
  type LucideIcon,
} from 'lucide-react'
import { InboxPage } from '@/pages/inbox'
import { TasksPage } from '@/pages/tasks'
import { CalendarPage } from '@/pages/calendar'
import { HabitsPage } from '@/pages/habits'
import { GoalsPage } from '@/pages/goals'
import { NotesPage } from '@/pages/notes'
import { ReviewPage } from '@/pages/review'
import type { Entity } from '@/core/types'

// ─── Config ───

const FAVORITES_KEY = 'lyra:focus-favorites'

export interface FavoriteConfig {
  id: string
  label: string
  icon: LucideIcon
  path: string
}

export const AVAILABLE_FAVORITES: FavoriteConfig[] = [
  { id: 'inbox', label: 'Quick Capture', icon: Inbox, path: '/inbox' },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare, path: '/tasks' },
  { id: 'calendar', label: 'Schedule', icon: Calendar, path: '/calendar' },
  { id: 'habits', label: 'Habits', icon: Repeat, path: '/habits' },
  { id: 'goals', label: 'Goals', icon: Target, path: '/goals' },
  { id: 'notes', label: 'Notes', icon: NotebookPen, path: '/notes' },
  { id: 'review', label: 'Review', icon: ClipboardCheck, path: '/review' },
]

export function getFocusFavorites(): string[] {
  try {
    const stored = localStorage.getItem(FAVORITES_KEY)
    if (stored) return JSON.parse(stored)
  } catch { /* ignore */ }
  return ['inbox', 'calendar', 'habits']
}

export function saveFocusFavorites(ids: string[]) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids))
}

// ─── Favorites Editor ───

export function FavoritesEditor({
  selected,
  onChange,
}: {
  selected: string[]
  onChange: (ids: string[]) => void
}) {
  const toggle = (id: string) => {
    const next = selected.includes(id)
      ? selected.filter((x) => x !== id)
      : [...selected, id]
    onChange(next)
    saveFocusFavorites(next)
  }

  return (
    <div className="flex flex-wrap gap-1.5 py-3 px-1">
      {AVAILABLE_FAVORITES.map((fav) => {
        const Icon = fav.icon
        const active = selected.includes(fav.id)
        return (
          <button
            key={fav.id}
            onClick={() => toggle(fav.id)}
            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-[11px] font-medium transition-colors cursor-pointer ${
              active
                ? 'bg-primary/10 text-primary border border-primary/20'
                : 'bg-muted/40 text-muted-foreground/40 hover:text-muted-foreground hover:bg-muted/60'
            }`}
          >
            <Icon className="h-3 w-3" />
            {fav.label}
          </button>
        )
      })}
    </div>
  )
}

// ─── Tab Bar ───

export function getTabBadge(id: string, allEntities: Entity[], today: string): number {
  switch (id) {
    case 'inbox':
      return allEntities.filter((e) => e.metadata.isInbox === true && e.status === 'todo').length
    case 'tasks':
      return allEntities.filter((e) =>
        (e.type === 'task' || e.type === 'chore') &&
        e.status !== 'done' && e.status !== 'archived' &&
        e.dueDate && e.dueDate <= today,
      ).length
    case 'calendar':
      return allEntities.filter((e) => e.type === 'event' && e.status === 'todo' && e.dueDate === today).length
    case 'habits':
      return allEntities.filter((e) => e.type === 'habit' && e.status === 'todo').length
    case 'goals':
      return allEntities.filter((e) => e.type === 'goal' && (e.status === 'todo' || e.status === 'in-progress')).length
    case 'notes':
      return allEntities.filter((e) => e.type === 'note' && e.metadata.isJournal !== true).length
    default:
      return 0
  }
}

export function FocusTabBar({
  activeTab,
  onTabChange,
  favoriteIds,
  allEntities,
  today,
  onEditFavorites,
}: {
  activeTab: string
  onTabChange: (tab: string) => void
  favoriteIds: string[]
  allEntities: Entity[]
  today: string
  onEditFavorites: () => void
}) {
  const tabs = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard, badge: 0 },
    ...favoriteIds
      .map((id) => AVAILABLE_FAVORITES.find((f) => f.id === id))
      .filter(Boolean)
      .map((fav) => ({
        id: fav!.id,
        label: fav!.label,
        icon: fav!.icon,
        badge: getTabBadge(fav!.id, allEntities, today),
      })),
  ]

  return (
    <nav className="flex items-center border-b border-border/60 -mx-1">
      {tabs.map((tab) => {
        const Icon = tab.icon
        const isActive = activeTab === tab.id
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`relative flex items-center gap-1.5 px-3 py-2 text-sm transition-colors cursor-pointer ${
              isActive
                ? 'text-foreground font-medium'
                : 'text-muted-foreground hover:text-foreground'
            }`}
          >
            <Icon className="h-4 w-4" />
            <span className="hidden sm:inline">{tab.label}</span>
            {tab.badge > 0 && (
              <span className={`min-w-[18px] h-[18px] rounded-full text-[11px] flex items-center justify-center px-1 ${
                isActive
                  ? 'bg-foreground/10 text-foreground'
                  : 'bg-muted text-muted-foreground'
              }`}>
                {tab.badge > 99 ? '99+' : tab.badge}
              </span>
            )}
            {/* Active underline */}
            {isActive && (
              <span className="absolute bottom-0 left-2 right-2 h-0.5 rounded-full bg-primary" />
            )}
          </button>
        )
      })}
      <button
        onClick={onEditFavorites}
        className="p-2 text-muted-foreground/30 hover:text-muted-foreground transition-colors ml-auto cursor-pointer"
        title="Edit tabs"
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>
    </nav>
  )
}

// ─── Tab Content — renders actual page components inline ───

export function FavoriteTabContent({ id }: { id: string }) {
  switch (id) {
    case 'inbox': return <InboxPage embedded />
    case 'tasks': return <TasksPage />
    case 'calendar': return <CalendarPage embedded />
    case 'habits': return <HabitsPage />
    case 'goals': return <GoalsPage />
    case 'notes': return <NotesPage />
    case 'review': return <ReviewPage embedded />
    default: return null
  }
}
