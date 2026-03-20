import { useState, useMemo, useCallback, useEffect, memo } from 'react'
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
  CheckSquare,
  ChevronDown,
  ChevronRight,
  GripVertical,
  Target,
  Plus,
  ListChecks,
  Crown,
  ChevronsUp,
  ArrowUp,
  ArrowDown,
  Minus,
  Calendar,
} from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Checkbox } from '@/components/ui/checkbox'
import { useEntities, useTrackers } from '@/core/hooks'
import { useICalEvents } from '@/hooks/use-ical-events'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useFocusStore } from '@/stores/focus-store'
import { PriorityPicker } from './today/priority-picker'
import { getRecurrence, buildRecurringNext } from './tasks/task-helpers'
import { getTodayPriorities, setTodayPriorities } from './today/today-helpers'
import {
  getFocusFavorites,
  saveFocusFavorites,
  FavoritesEditor,
  FocusTabBar,
  FavoriteTabContent,
} from './today/focus-favorites'
import type { Entity } from '@/core/types'

function isProtocol(habit: Entity): boolean {
  return habit.metadata.isProtocol === true && Array.isArray(habit.metadata.steps)
}

function getCompletedSteps(trackerNote: string | undefined | null): string[] {
  if (!trackerNote) return []
  try {
    const parsed = JSON.parse(trackerNote)
    if (Array.isArray(parsed)) return parsed
  } catch {
    // Not JSON
  }
  return []
}

interface ProtocolStep {
  id: string
  label: string
  order: number
}

function getGreeting(): string {
  const h = new Date().getHours()
  if (h < 12) return 'Good morning'
  if (h < 17) return 'Good afternoon'
  return 'Good evening'
}

/* ─── Section header ─── */
function SH({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">{children}</h2>
      {action}
    </div>
  )
}

/* ─── Live Clock — isolated to avoid full-page re-renders every second ─── */
const LiveClock = memo(function LiveClock() {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const [time, setTime] = useState(() =>
    new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
  )
  useEffect(() => {
    const timer = setInterval(() => {
      setTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }))
    }, 1000)
    return () => clearInterval(timer)
  }, [])
  return <span className="tabular-nums">{time} <span className="text-muted-foreground/40">{tz}</span></span>
})


const QuickAddInput = memo(function QuickAddInput({ placeholder, onAdd }: { placeholder: string; onAdd: (title: string) => void }) {
  const [value, setValue] = useState('')
  return (
    <div className="flex items-center gap-2 mt-1">
      <input
        className="flex-1 text-sm bg-transparent border-0 border-b border-dashed border-muted-foreground/20 px-0 py-1 focus:outline-none focus:border-primary placeholder:text-muted-foreground/30"
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && value.trim()) {
            onAdd(value.trim())
            setValue('')
          }
        }}
      />
    </div>
  )
})

/* ─── Sortable subtask row for Focus page ─── */

function SortableFocusSubtask({
  sub,
  item,
  onToggle,
}: {
  sub: { id: string; title: string; done: boolean; status?: 'todo' | 'in-progress' | 'done'; priority?: 'urgent' | 'high' | 'medium' | 'low' }
  item: Entity
  onToggle: (entity: Entity, subtaskId: string) => void
}) {
  const st = sub.status ?? (sub.done ? 'done' : 'todo')
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: sub.id })

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 50 : undefined,
    opacity: isDragging ? 0.5 : undefined,
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`flex items-center gap-2.5 py-1 rounded px-1 transition-colors bg-background ${
        st === 'in-progress' ? 'bg-amber-500/[0.06]' : 'hover:bg-muted/40'
      }`}
    >
      <button
        type="button"
        className="shrink-0 cursor-grab active:cursor-grabbing text-muted-foreground/30 hover:text-muted-foreground touch-none"
        {...attributes}
        {...listeners}
      >
        <GripVertical className="h-3 w-3" />
      </button>
      <button
        onClick={() => onToggle(item, sub.id)}
        className={`h-3.5 w-3.5 shrink-0 rounded-full border-2 flex items-center justify-center transition-colors cursor-pointer ${
          st === 'done'
            ? 'bg-primary border-primary text-primary-foreground'
            : st === 'in-progress'
              ? 'border-amber-500 bg-amber-500/20'
              : 'border-muted-foreground/30'
        }`}
        title={`${st} — click to cycle`}
      >
        {st === 'done' && (
          <svg className="h-2 w-2" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        )}
        {st === 'in-progress' && (
          <div className="h-1 w-1 rounded-full bg-amber-500" />
        )}
      </button>
      {st === 'in-progress' && (
        <span className="text-[9px] font-medium px-1 py-px rounded bg-amber-500/15 text-amber-600 dark:text-amber-400 shrink-0">WIP</span>
      )}
      {sub.priority === 'urgent' && <ChevronsUp className="h-3.5 w-3.5 text-red-500 shrink-0" />}
      {sub.priority === 'high' && <ArrowUp className="h-3.5 w-3.5 text-orange-500 shrink-0" />}
      {sub.priority === 'medium' && <Minus className="h-3.5 w-3.5 text-yellow-500 shrink-0" />}
      {sub.priority === 'low' && <ArrowDown className="h-3.5 w-3.5 text-blue-400 shrink-0" />}
      <span className={`text-sm ${
        st === 'done' ? 'line-through text-muted-foreground/60' :
        st === 'in-progress' ? 'font-medium text-amber-700 dark:text-amber-300' : ''
      }`}>
        {sub.title}
      </span>
    </div>
  )
}

/* ─── Focus Story — collapsible subtask card ─── */
const FocusStory = memo(function FocusStory({
  item,
  subs,
  doneCount,
  pct,
  allDone,
  onToggleSubtask,
  onAddSubtask,
  onReorderSubtasks,
}: {
  item: Entity
  subs: Array<{ id: string; title: string; done: boolean; status?: 'todo' | 'in-progress' | 'done' }>
  doneCount: number
  pct: number
  allDone: boolean
  onToggleSubtask: (entity: Entity, subtaskId: string) => void
  onAddSubtask: (entity: Entity, title: string) => void
  onReorderSubtasks: (entity: Entity, event: DragEndEvent) => void
}) {
  const [expanded, setExpanded] = useState(false)
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  )

  return (
    <div className={`rounded-lg border transition-colors ${
      allDone ? 'border-green-500/40 bg-green-50/20 dark:bg-green-950/10' : 'bg-card/50'
    }`}>
      {/* Story header — click to toggle */}
      <div className="flex items-center gap-3 w-full p-3 hover:bg-muted/30 rounded-lg transition-colors">
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-3 flex-1 min-w-0 text-left cursor-pointer"
        >
          <ListChecks className="h-4 w-4 text-purple-500 shrink-0" />
          {expanded
            ? <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
            : <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40 shrink-0" />
          }
          <span className={`text-sm flex-1 font-medium truncate ${allDone ? 'line-through text-muted-foreground' : ''}`}>
            {item.title}
          </span>
        </button>
        {typeof item.metadata.workspace === 'string' && (
          <span className="text-[10px] text-muted-foreground/40 shrink-0">
            {item.metadata.workspace === 'work' ? '🏢' : '🏠'}
          </span>
        )}
        <span className={`text-xs tabular-nums shrink-0 ${
          allDone ? 'text-green-600 dark:text-green-400 font-medium' : 'text-muted-foreground'
        }`}>
          {doneCount}/{subs.length}
        </span>
      </div>

      {/* Subtasks — drag to reorder */}
      {expanded && (
        <div className="px-3 pb-3 space-y-1.5">
          <div className="space-y-0.5 pl-1">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={(e) => onReorderSubtasks(item, e)}
            >
              <SortableContext items={subs.map((s) => s.id)} strategy={verticalListSortingStrategy}>
                {subs.map((sub) => (
                  <SortableFocusSubtask
                    key={sub.id}
                    sub={sub}
                    item={item}
                    onToggle={onToggleSubtask}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>

          <QuickAddInput
            placeholder="+ Add step..."
            onAdd={(title) => onAddSubtask(item, title)}
          />

          <Progress value={pct} className="h-1" />
        </div>
      )}

      {/* Collapsed progress bar */}
      {!expanded && <Progress value={pct} className="h-1 mx-3 mb-2" />}
    </div>
  )
})

export function TodayPage() {
  const { items: allEntities, update, create } = useEntities()
  const { items: allTrackers, create: createTracker, update: updateTracker } = useTrackers()
  const { events: icalEvents } = useICalEvents()
  const currentUser = useAuthStore((s) => s.currentUser)
  const navigate = useNavigate()
  const displayName = currentUser?.name?.split(' ')[0] ?? 'there'

  const hasActiveSession = useFocusStore((s) => !!s.sessionId && s.emperorEntityIds.length > 0)
  const focusSecondsLeft = useFocusStore((s) => s.secondsLeft)

  const [priorities, setPriorities] = useState<string[]>(() => getTodayPriorities())
  const [addingStory, setAddingStory] = useState(false)
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => getFocusFavorites())
  const [editingFavs, setEditingFavs] = useState(false)
  const [activeTab, setActiveTab] = useState('overview')

  const today = new Date().toISOString().split('T')[0]
  const todayStart = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }, [])

  // ─── Data queries ───

  const priorityEntities = useMemo(
    () => priorities.map((id) => allEntities.find((e) => e.id === id)).filter(Boolean) as Entity[],
    [priorities, allEntities],
  )

  const priorityCandidates = useMemo(
    () => allEntities.filter((e) => (e.type === 'task' || e.type === 'goal') && (e.status === 'todo' || e.status === 'in-progress')),
    [allEntities],
  )

  // Due tasks + chores: active, due today or overdue
  const todayTasks = useMemo(() => {
    const items = allEntities.filter(
      (e) =>
        (e.type === 'task' || e.type === 'chore') &&
        e.status === 'todo' &&
        e.dueDate &&
        e.dueDate <= today,
    )
    const order = { urgent: 0, high: 1, medium: 2, low: 3 }
    items.sort((a, b) => (order[a.priority as keyof typeof order] ?? 2) - (order[b.priority as keyof typeof order] ?? 2))
    return items
  }, [allEntities, today])


  // Keep actionItems reference for metrics (total count of active items)
  const actionItems = todayTasks

  const todayICalEvents = useMemo(
    () => icalEvents
      .filter((e) => {
        // Use local date (not UTC) to match timezone-aware "today"
        const d = e.start
        const localDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        return localDate === today
      })
      .sort((a, b) => a.start.getTime() - b.start.getTime()),
    [icalEvents, today],
  )

  const activeHabits = useMemo(
    () => allEntities.filter((e) => e.type === 'habit' && e.status === 'todo'),
    [allEntities],
  )

  const protocols = useMemo(
    () => activeHabits.filter(isProtocol),
    [activeHabits],
  )

  const habits = useMemo(
    () => activeHabits
      .filter((e) => !isProtocol(e))
      .map((habit) => ({
        habit,
        checkedToday: allTrackers.some((t) => t.entityId === habit.id && t.timestamp >= todayStart),
        streak: typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0,
      })),
    [activeHabits, allTrackers, todayStart],
  )

  const getTodayTracker = useCallback(
    (habitId: string) =>
      allTrackers.find(
        (t) => t.entityId === habitId && t.timestamp >= todayStart,
      ),
    [allTrackers, todayStart],
  )

  const protocolsData = useMemo(
    () => protocols.map((habit) => {
      const tracker = getTodayTracker(habit.id)
      const completedSteps = getCompletedSteps(tracker?.note)
      const steps = Array.isArray(habit.metadata.steps)
        ? (habit.metadata.steps as ProtocolStep[]).sort((a, b) => a.order - b.order)
        : []
      return { habit, steps, completedSteps, totalSteps: steps.length }
    }),
    [protocols, getTodayTracker],
  )

  // Active Projects — for quick nav count
  // ─── Metrics ───

  const habitsChecked = habits.filter((h) => h.checkedToday).length
  const totalItems = actionItems.length + habits.length
  const doneItems = actionItems.filter((i) => i.status === 'done').length + habitsChecked

  // Focus Score: based on subtask completion across stories + simple task completion
  const focusScore = useMemo(() => {
    if (priorities.length === 0) return null
    let totalSteps = 0
    let doneSteps = 0
    for (const entity of priorityEntities) {
      const subs = Array.isArray(entity.metadata.subtasks) ? (entity.metadata.subtasks as Array<{ done: boolean; status?: string }>) : []
      if (subs.length > 0) {
        totalSteps += subs.length
        doneSteps += subs.filter((s) => (s.status ? s.status === 'done' : s.done)).length
      } else {
        totalSteps += 1
        if (entity.status === 'done') doneSteps += 1
      }
    }
    return totalSteps > 0 ? Math.round((doneSteps / totalSteps) * 100) : 0
  }, [priorities, priorityEntities])

  // ─── Handlers ───

  const handleSavePriorities = useCallback((ids: string[]) => {
    const merged = [...new Set([...priorities, ...ids])]
    setTodayPriorities(merged)
    setPriorities(merged)
    setAddingStory(false)
    notify({ title: 'Focus updated', type: 'success' })
  }, [priorities])

  const toggleSubtask = useCallback(
    (entity: Entity, subtaskId: string) => {
      const subs = Array.isArray(entity.metadata.subtasks)
        ? (entity.metadata.subtasks as Array<{ id: string; title: string; done: boolean; status?: 'todo' | 'in-progress' | 'done' }>)
        : []
      const updated = subs.map((s) => {
        if (s.id !== subtaskId) return s
        const current = s.status ?? (s.done ? 'done' : 'todo')
        const next = current === 'todo' ? 'in-progress' : current === 'in-progress' ? 'done' : 'todo'
        return { ...s, done: next === 'done', status: next as 'todo' | 'in-progress' | 'done' }
      })
      const allDone = updated.length > 0 && updated.every((s) => s.status === 'done' || (!s.status && s.done))
      const hasWip = updated.some((s) => s.status === 'in-progress')
      const hasDone = updated.some((s) => s.status === 'done' || (!s.status && s.done))
      const derivedStatus = allDone ? 'done' : (hasWip || hasDone) ? 'in-progress' : entity.status
      update.mutate({
        id: entity.id,
        updates: {
          metadata: { ...entity.metadata, subtasks: updated },
          status: derivedStatus,
          updatedAt: new Date().toISOString(),
        },
      })
    },
    [update],
  )

  const addSubtask = useCallback(
    (entity: Entity, title: string) => {
      const subs = Array.isArray(entity.metadata.subtasks)
        ? (entity.metadata.subtasks as Array<{ id: string; title: string; done: boolean }>)
        : []
      update.mutate({
        id: entity.id,
        updates: {
          metadata: {
            ...entity.metadata,
            subtasks: [...subs, { id: crypto.randomUUID(), title, done: false, status: 'todo' as const }],
          },
          updatedAt: new Date().toISOString(),
        },
      })
    },
    [update],
  )

  const reorderSubtasks = useCallback(
    (entity: Entity, event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const subs = Array.isArray(entity.metadata.subtasks)
        ? (entity.metadata.subtasks as Array<{ id: string; title: string; done: boolean; status?: string }>)
        : []
      const oldIndex = subs.findIndex((s) => s.id === active.id)
      const newIndex = subs.findIndex((s) => s.id === over.id)
      if (oldIndex === -1 || newIndex === -1) return
      const updated = [...subs]
      const [moved] = updated.splice(oldIndex, 1)
      updated.splice(newIndex, 0, moved)
      update.mutate({
        id: entity.id,
        updates: { metadata: { ...entity.metadata, subtasks: updated } },
      })
    },
    [update],
  )

  const toggleItem = useCallback(
    (item: Entity) => {
      const newStatus = item.status === 'done' ? 'todo' : 'done'
      update.mutate({
        id: item.id,
        updates: {
          status: newStatus,
          updatedAt: new Date().toISOString(),
        },
      })
      // Spawn next occurrence for recurring tasks
      if (newStatus === 'done' && getRecurrence(item.metadata) !== 'none') {
        const now = new Date().toISOString()
        const next = buildRecurringNext(item)
        create.mutate({
          ...next,
          id: crypto.randomUUID(),
          createdAt: now,
          updatedAt: now,
        })
        notify({ title: `Next "${item.title}" created`, type: 'success' })
      }
    },
    [update, create],
  )

  const handleToggleStep = useCallback(
    (habit: Entity, stepId: string, completed: boolean) => {
      const existing = getTodayTracker(habit.id)
      const currentSteps = getCompletedSteps(existing?.note)
      const steps = (habit.metadata.steps as ProtocolStep[]) || []
      const totalSteps = steps.length

      let newSteps: string[]
      if (completed) {
        newSteps = [...new Set([...currentSteps, stepId])]
      } else {
        newSteps = currentSteps.filter((s) => s !== stepId)
      }

      const allDone = newSteps.length >= totalSteps
      const wasDone = currentSteps.length >= totalSteps

      if (existing) {
        updateTracker.mutate({
          id: existing.id,
          updates: { note: JSON.stringify(newSteps) },
        })
      } else {
        createTracker.mutate({
          id: crypto.randomUUID(),
          entityId: habit.id,
          value: 1,
          unit: 'done',
          note: JSON.stringify(newSteps),
          timestamp: new Date().toISOString(),
          ownerId: currentUser?.id ?? '',
        })
      }

      if (allDone && !wasDone) {
        const streak = typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0
        update.mutate({
          id: habit.id,
          updates: {
            metadata: { ...habit.metadata, streak: streak + 1 },
            updatedAt: new Date().toISOString(),
          },
        })
      } else if (!allDone && wasDone) {
        const streak = typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0
        update.mutate({
          id: habit.id,
          updates: {
            metadata: { ...habit.metadata, streak: Math.max(0, streak - 1) },
            updatedAt: new Date().toISOString(),
          },
        })
      }
    },
    [getTodayTracker, createTracker, updateTracker, update, currentUser],
  )

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div className="h-[calc(100vh-5rem)] flex flex-col">
      {/* ─── Header ─── */}
      <header className="shrink-0 pb-4 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight truncate">
            {getGreeting()}, {displayName}
          </h1>
          <p className="text-xs text-muted-foreground mt-0.5">
            {dateStr} &middot; <LiveClock />
          </p>
        </div>
        <div className="flex items-center gap-3">
          {focusScore !== null && (
            <span className={`text-xs font-medium tabular-nums ${
              focusScore >= 100
                ? 'text-green-600 dark:text-green-400'
                : focusScore >= 50
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-muted-foreground'
            }`}>
              {focusScore}%
            </span>
          )}
          {totalItems > 0 && (
            <div className="flex items-center gap-2 min-w-[100px]">
              <Progress value={Math.round((doneItems / totalItems) * 100)} className="h-1 flex-1" />
              <span className="text-[10px] tabular-nums text-muted-foreground/60">{doneItems}/{totalItems}</span>
            </div>
          )}
        </div>
      </header>

      {/* ─── Tab Bar ─── */}
      <div className="shrink-0 pb-4">
        <FocusTabBar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          favoriteIds={favoriteIds}
          allEntities={allEntities}
          today={today}
          onEditFavorites={() => setEditingFavs(!editingFavs)}
        />
        {editingFavs && (
          <div className="space-y-2 pt-2">
            <FavoritesEditor
              selected={favoriteIds}
              onChange={(ids) => { setFavoriteIds(ids); saveFocusFavorites(ids) }}
            />
            <button
              onClick={() => setEditingFavs(false)}
              className="text-[10px] text-muted-foreground/40 hover:text-muted-foreground transition-colors"
            >
              Done
            </button>
          </div>
        )}
      </div>

      {/* ─── Content ─── */}
      {activeTab !== 'overview' ? (
        <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
          <FavoriteTabContent id={activeTab} />
        </div>
      ) : (
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* ═══ LEFT — Focus + Protocols (7/12) ═══ */}
        <div className="lg:col-span-7 min-h-0 overflow-y-auto space-y-6 pr-1 scrollbar-thin">

          {/* Today Focus — story-based */}
          <section>
            {priorities.length > 0 ? (
              <Collapsible defaultOpen>
                <div className="flex items-center justify-between mb-2">
                  <CollapsibleTrigger className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                    <ChevronRight className="h-3 w-3 transition-transform [[data-state=open]>&]:rotate-90" />
                    <Target className="h-3 w-3 inline -mt-px" />
                    Today Focus
                    <span className="text-muted-foreground/50 font-normal normal-case tracking-normal ml-1">
                      {priorityEntities.filter((i) => i.status === 'done').length}/{priorityEntities.length}
                    </span>
                  </CollapsibleTrigger>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="outline"
                      size="sm"
                      className={`h-6 px-2 text-[11px] gap-1 text-amber-600 dark:text-amber-400 border-amber-500/30 hover:bg-amber-500/10 ${
                        hasActiveSession ? 'animate-pulse' : ''
                      }`}
                      onClick={() => {
                        const store = useFocusStore.getState()
                        const same = store.emperorEntityIds.length === priorities.length &&
                          priorities.every((id) => store.emperorEntityIds.includes(id))
                        if (!same || !store.sessionId) {
                          store.startEmperorTime(priorities)
                        }
                        navigate('/deep-work')
                      }}
                    >
                      <Crown className="h-3 w-3" />
                      {hasActiveSession && focusSecondsLeft > 0
                        ? <>Continue {Math.floor(focusSecondsLeft / 60)}:{String(focusSecondsLeft % 60).padStart(2, '0')}</>
                        : 'Deep Focus'
                      }
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 text-[11px] text-muted-foreground/50"
                      onClick={() => { setTodayPriorities([]); setPriorities([]) }}
                    >
                      Reset
                    </Button>
                  </div>
                </div>
                <CollapsibleContent>
                <div className="space-y-2">
                  {priorityEntities.map((item) => {
                    const subs = Array.isArray(item.metadata.subtasks)
                      ? (item.metadata.subtasks as Array<{ id: string; title: string; done: boolean; status?: 'todo' | 'in-progress' | 'done' }>)
                      : []
                    const hasSubs = subs.length > 0
                    const doneCount = subs.filter((s) => (s.status ? s.status === 'done' : s.done)).length
                    const pct = hasSubs ? Math.round((doneCount / subs.length) * 100) : 0
                    const allDone = item.status === 'done' || (hasSubs && doneCount === subs.length)
                    const isGoal = item.type === 'goal'
                    const goalProgress = typeof item.metadata.progress === 'number' ? (item.metadata.progress as number) : 0

                    if (isGoal) {
                      return (
                        <button
                          key={item.id}
                          onClick={() => navigate(`/goals?id=${item.id}`)}
                          className="flex items-center gap-3 w-full py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors text-left group"
                        >
                          <Target className="h-4 w-4 text-green-500 shrink-0" />
                          <span className="text-sm flex-1 font-medium truncate">{item.title}</span>
                          <div className="flex items-center gap-2 shrink-0">
                            <Progress value={goalProgress} className="h-1.5 w-16" />
                            <span className="text-[11px] tabular-nums text-muted-foreground">{goalProgress}%</span>
                            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/30" />
                          </div>
                        </button>
                      )
                    }

                    if (!hasSubs) {
                      return (
                        <div key={item.id} className="flex items-center gap-3 py-2.5 px-3 rounded-lg hover:bg-muted/50 transition-colors">
                          <CheckSquare className="h-4 w-4 text-blue-500 shrink-0" />
                          <Checkbox
                            checked={item.status === 'done'}
                            onCheckedChange={() => toggleItem(item)}
                            className="shrink-0"
                          />
                          <span className={`text-sm flex-1 truncate ${item.status === 'done' ? 'line-through text-muted-foreground' : 'font-medium'}`}>
                            {item.title}
                          </span>
                          {typeof item.metadata.workspace === 'string' && (
                            <span className="text-[10px] text-muted-foreground/40">
                              {item.metadata.workspace === 'work' ? '🏢' : '🏠'}
                            </span>
                          )}
                        </div>
                      )
                    }

                    return (
                      <FocusStory
                        key={item.id}
                        item={item}
                        subs={subs}
                        doneCount={doneCount}
                        pct={pct}
                        allDone={allDone}
                        onToggleSubtask={toggleSubtask}
                        onAddSubtask={addSubtask}
                        onReorderSubtasks={reorderSubtasks}
                      />
                    )
                  })}
                </div>

                {priorities.length < 3 && !addingStory && (
                  <button
                    className="text-xs text-muted-foreground/40 hover:text-muted-foreground transition-colors mt-3 flex items-center gap-1"
                    onClick={() => setAddingStory(true)}
                  >
                    <Plus className="h-3 w-3" /> Add to focus
                  </button>
                )}

                {addingStory && (
                  <div className="mt-3">
                    <PriorityPicker
                      candidates={priorityCandidates}
                      existingIds={priorities}
                      onSave={handleSavePriorities}
                    />
                    <button
                      className="text-xs text-muted-foreground/40 hover:text-muted-foreground transition-colors mt-2"
                      onClick={() => setAddingStory(false)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
                </CollapsibleContent>
              </Collapsible>
            ) : (
              <PriorityPicker
                candidates={priorityCandidates}
                onSave={handleSavePriorities}
              />
            )}
          </section>

          {/* Today's Protocols */}
          {protocolsData.length > 0 && (
            <section>
              <SH>
                <ListChecks className="h-3 w-3 inline mr-1.5 -mt-px" />
                Today&apos;s Protocols
              </SH>
              <div className="space-y-3">
                {protocolsData.map(({ habit, steps, completedSteps, totalSteps }) => {
                  const pct = totalSteps > 0 ? Math.round((completedSteps.length / totalSteps) * 100) : 0
                  const allDone = totalSteps > 0 && completedSteps.length >= totalSteps
                  return (
                    <div
                      key={habit.id}
                      className={`rounded-lg border p-3 space-y-2 transition-colors ${
                        allDone ? 'border-green-500/50 bg-green-50/30 dark:bg-green-950/10' : 'bg-card/50'
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium truncate">{habit.title}</span>
                        <span className={`text-xs tabular-nums shrink-0 ${
                          allDone ? 'text-green-600 dark:text-green-400 font-medium' : 'text-muted-foreground'
                        }`}>
                          {completedSteps.length}/{totalSteps}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1">
                        {steps.map((step) => {
                          const isDone = completedSteps.includes(step.id)
                          return (
                            <label
                              key={step.id}
                              className="flex items-center gap-1.5 py-0.5 cursor-pointer"
                            >
                              <Checkbox
                                checked={isDone}
                                onCheckedChange={(checked) => handleToggleStep(habit, step.id, !!checked)}
                                className="h-3.5 w-3.5 shrink-0"
                              />
                              <span className={`text-xs ${isDone ? 'line-through text-muted-foreground' : ''}`}>
                                {step.label}
                              </span>
                            </label>
                          )
                        })}
                      </div>
                      <Progress value={pct} className="h-1" />
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          <div className="pb-6" />
        </div>

        {/* ═══ RIGHT — Schedule (5/12) ═══ */}
        <aside className="lg:col-span-5 min-h-0 overflow-y-auto space-y-5 scrollbar-thin">
          {/* Today's Schedule */}
          <section>
            <SH>
              <Calendar className="h-3 w-3 inline mr-1.5 -mt-px" />
              Today&apos;s Schedule
            </SH>
            {todayICalEvents.length === 0 ? (
              <p className="text-xs text-muted-foreground/30">No events today.</p>
            ) : (
              <div className="space-y-0.5">
                {todayICalEvents.map((event) => (
                  <div key={event.id} className="flex items-center gap-3 py-1.5 px-2 rounded-md hover:bg-muted/40 transition-colors">
                    <span className="text-xs tabular-nums text-muted-foreground/50 w-14 shrink-0">
                      {event.isAllDay ? 'All day' : event.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: event.color || '#7986cb' }} />
                    <span className="text-sm flex-1 truncate">{event.title}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>
      )}

    </div>
  )
}
