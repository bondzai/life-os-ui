import {
  Inbox,
  CheckSquare,
  Calendar,
  Repeat,
  Target,
  NotebookPen,
  FileText,
  ClipboardCheck,
  ChevronRight,
  type LucideIcon,
} from 'lucide-react'
import { useNavigate } from 'react-router'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
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
  { id: 'inbox', label: 'Inbox', icon: Inbox, path: '/inbox' },
  { id: 'tasks', label: 'Tasks', icon: CheckSquare, path: '/tasks' },
  { id: 'calendar', label: 'Schedule', icon: Calendar, path: '/calendar' },
  { id: 'habits', label: 'Habits', icon: Repeat, path: '/habits' },
  { id: 'goals', label: 'Goals', icon: Target, path: '/goals' },
  { id: 'notes', label: 'Notes', icon: NotebookPen, path: '/notes' },
  { id: 'report', label: 'Report', icon: FileText, path: '/report' },
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
    <div className="flex flex-wrap gap-1.5">
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

// ─── Favorite Widget ───

export interface ICalEvent {
  id: string
  title: string
  start: Date
  isAllDay: boolean
  color?: string
}

interface WidgetData {
  allEntities: Entity[]
  today: string
  habitCheckedMap: Map<string, boolean>
  iCalEvents?: ICalEvent[]
  onToggleTask?: (entity: Entity) => void
  onToggleHabit?: (entity: Entity) => void
}

export function FavoriteWidget({ id, ...data }: WidgetData & { id: string }) {
  const navigate = useNavigate()
  const fav = AVAILABLE_FAVORITES.find((f) => f.id === id)
  if (!fav) return null
  const Icon = fav.icon
  const { content, count } = renderContent(id, data)

  return (
    <section>
      <button
        onClick={() => navigate(fav.path)}
        className="flex items-center gap-1.5 w-full mb-1.5 group cursor-pointer"
      >
        <Icon className="h-3 w-3 text-muted-foreground/40" />
        <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50 group-hover:text-muted-foreground transition-colors">
          {fav.label}
        </span>
        {count > 0 && (
          <span className="text-[10px] text-muted-foreground/30">{count}</span>
        )}
        <ChevronRight className="h-3 w-3 text-muted-foreground/20 ml-auto opacity-0 group-hover:opacity-100 transition-opacity" />
      </button>
      {content}
    </section>
  )
}

function renderContent(
  id: string,
  { allEntities, today, habitCheckedMap, iCalEvents, onToggleTask, onToggleHabit }: WidgetData,
): { content: React.ReactNode; count: number } {
  switch (id) {
    case 'inbox': {
      const items = allEntities.filter((e) => e.metadata.isInbox === true && e.status === 'todo')
      return {
        count: items.length,
        content: items.length === 0
          ? <p className="text-xs text-muted-foreground/30 py-1">Inbox zero</p>
          : (
            <div className="space-y-0.5">
              {items.slice(0, 5).map((item) => (
                <p key={item.id} className="text-sm truncate py-0.5 text-muted-foreground">{item.title}</p>
              ))}
              {items.length > 5 && <p className="text-[10px] text-muted-foreground/30">+{items.length - 5} more</p>}
            </div>
          ),
      }
    }

    case 'tasks': {
      const items = allEntities
        .filter((e) =>
          (e.type === 'task' || e.type === 'chore') &&
          e.status !== 'done' && e.status !== 'archived' &&
          e.dueDate && e.dueDate <= today,
        )
        .sort((a, b) => {
          const order = { urgent: 0, high: 1, medium: 2, low: 3 }
          return (order[a.priority as keyof typeof order] ?? 2) - (order[b.priority as keyof typeof order] ?? 2)
        })
      return {
        count: items.length,
        content: items.length === 0
          ? <p className="text-xs text-muted-foreground/30 py-1">All clear</p>
          : (
            <div className="space-y-0.5">
              {items.slice(0, 6).map((item) => (
                <div key={item.id} className="flex items-center gap-2 py-0.5">
                  <Checkbox
                    checked={false}
                    onCheckedChange={() => onToggleTask?.(item)}
                    className="h-3.5 w-3.5 shrink-0"
                  />
                  <span className="text-sm truncate">{item.title}</span>
                </div>
              ))}
              {items.length > 6 && <p className="text-[10px] text-muted-foreground/30">+{items.length - 6} more</p>}
            </div>
          ),
      }
    }

    case 'calendar': {
      const events = allEntities
        .filter((e) => e.type === 'event' && e.status === 'todo' && e.dueDate === today)
        .sort((a, b) => ((a.metadata.time as string) ?? '').localeCompare((b.metadata.time as string) ?? ''))
      const total = events.length + (iCalEvents?.length ?? 0)
      return {
        count: total,
        content: total === 0
          ? <p className="text-xs text-muted-foreground/30 py-1">No events today</p>
          : (
            <div className="space-y-0.5">
              {events.map((event) => (
                <div key={event.id} className="flex items-center gap-2.5 py-1">
                  <span className="text-[11px] tabular-nums text-muted-foreground/40 w-12 shrink-0">
                    {(event.metadata.time as string) ?? 'All day'}
                  </span>
                  <span className="w-1.5 h-1.5 rounded-full bg-blue-500/60 shrink-0" />
                  <span className="text-sm truncate">{event.title}</span>
                </div>
              ))}
              {iCalEvents?.map((event) => (
                <div key={event.id} className="flex items-center gap-2.5 py-1">
                  <span className="text-[11px] tabular-nums text-muted-foreground/40 w-12 shrink-0">
                    {event.isAllDay ? 'All day' : event.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                  <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: event.color || '#7986cb' }} />
                  <span className="text-sm truncate">{event.title}</span>
                </div>
              ))}
            </div>
          ),
      }
    }

    case 'habits': {
      const active = allEntities.filter((e) => e.type === 'habit' && e.status === 'todo' && e.metadata.isProtocol !== true)
      const checked = active.filter((h) => habitCheckedMap.get(h.id)).length
      return {
        count: active.length,
        content: active.length === 0
          ? <p className="text-xs text-muted-foreground/30 py-1">No habits</p>
          : (
            <div className="space-y-0.5">
              {active.slice(0, 8).map((habit) => {
                const done = habitCheckedMap.get(habit.id) ?? false
                const streak = typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0
                return (
                  <div key={habit.id} className="flex items-center gap-2 py-0.5">
                    <Checkbox
                      checked={done}
                      onCheckedChange={() => onToggleHabit?.(habit)}
                      className="h-3.5 w-3.5 shrink-0"
                    />
                    <span className={`text-sm truncate flex-1 ${done ? 'line-through text-muted-foreground/50' : ''}`}>
                      {habit.title}
                    </span>
                    {streak > 0 && <span className="text-[10px] tabular-nums text-muted-foreground/30">{streak}d</span>}
                  </div>
                )
              })}
              {checked > 0 && (
                <p className="text-[10px] text-muted-foreground/30 pt-0.5">{checked}/{active.length} done</p>
              )}
            </div>
          ),
      }
    }

    case 'goals': {
      const goals = allEntities.filter((e) => e.type === 'goal' && (e.status === 'todo' || e.status === 'in-progress'))
      return {
        count: goals.length,
        content: goals.length === 0
          ? <p className="text-xs text-muted-foreground/30 py-1">No active goals</p>
          : (
            <div className="space-y-1.5">
              {goals.slice(0, 5).map((goal) => {
                const progress = typeof goal.metadata.progress === 'number' ? (goal.metadata.progress as number) : 0
                return (
                  <div key={goal.id}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm truncate">{goal.title}</span>
                      <span className="text-[10px] tabular-nums text-muted-foreground/30">{progress}%</span>
                    </div>
                    <Progress value={progress} className="h-0.5 mt-0.5" />
                  </div>
                )
              })}
            </div>
          ),
      }
    }

    case 'notes': {
      const notes = allEntities
        .filter((e) => e.type === 'note' && e.metadata.isJournal !== true)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      return {
        count: notes.length,
        content: notes.length === 0
          ? <p className="text-xs text-muted-foreground/30 py-1">No notes</p>
          : (
            <div className="space-y-0.5">
              {notes.slice(0, 5).map((note) => (
                <p key={note.id} className="text-sm truncate py-0.5 text-muted-foreground">{note.title}</p>
              ))}
            </div>
          ),
      }
    }

    default:
      // report, review — no inline content, just the header link
      return { count: 0, content: null }
  }
}
