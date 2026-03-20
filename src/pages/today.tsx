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
  Inbox,
  ArrowRight,
  BookOpen,
  ListChecks,
  Crown,
  AlertTriangle,
  Archive,
  CalendarClock,
  RotateCcw,
} from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { useEntities, useTrackers } from '@/core/hooks'
import { useICalEvents } from '@/hooks/use-ical-events'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useFocusStore } from '@/stores/focus-store'
import { calcFocusStats, formatMinutes } from '@/lib/focus-stats'
import { PriorityPicker } from './today/priority-picker'
import { StandupReport } from './tasks/standup-report'
import { CaptureBar } from './today/capture-bar'
// DailyProtocol removed — protocols are on left column
import { isReviewDoneThisWeek, daysAgo } from './review/review-helpers'
import { getRecurrence, buildRecurringNext } from './tasks/task-helpers'
import { getTodayPriorities, setTodayPriorities } from './today/today-helpers'
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
  sub: { id: string; title: string; done: boolean; status?: 'todo' | 'in-progress' | 'done' }
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
  const [expanded, setExpanded] = useState(true)
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

  const [priorities, setPriorities] = useState<string[]>(() => getTodayPriorities())
  const [addingStory, setAddingStory] = useState(false)
  const [standupOpen, setStandupOpen] = useState(false)
  const [journalText, setJournalText] = useState('')
  const [showJournal, setShowJournal] = useState(false)

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

  const todayEvents = useMemo(
    () => allEntities
      .filter((e) => e.type === 'event' && e.status === 'todo' && e.dueDate === today)
      .sort((a, b) => ((a.metadata.time as string) ?? '').localeCompare((b.metadata.time as string) ?? '')),
    [allEntities, today],
  )

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

  const inboxItems = useMemo(
    () => allEntities.filter((e) => e.metadata.isInbox === true && e.status === 'todo'),
    [allEntities],
  )

  // Active Projects — for quick nav count
  const activeProjects = useMemo(() => {
    const childParentIds = new Set(
      allEntities.filter((e) => e.type === 'goal' && e.parentId).map((e) => e.parentId!),
    )
    // Projects = goals with children, or top-level goals with progress tracking
    const projects = allEntities.filter(
      (e) =>
        e.type === 'goal' &&
        e.status === 'todo' &&
        (childParentIds.has(e.id) || typeof e.metadata.progress === 'number'),
    )
    return projects.slice(0, 5)
  }, [allEntities])

  // Stale items — active but untouched 14+ days
  const STALE_DAYS = 14
  const staleItems = useMemo(
    () =>
      allEntities
        .filter(
          (e) =>
            ['task', 'goal', 'chore', 'note'].includes(e.type) &&
            e.status !== 'done' &&
            e.status !== 'archived' &&
            daysAgo(e.updatedAt) >= STALE_DAYS,
        )
        .sort((a, b) => daysAgo(b.updatedAt) - daysAgo(a.updatedAt)),
    [allEntities],
  )

  const handleArchiveStale = useCallback(
    (item: Entity) => {
      update.mutate({ id: item.id, updates: { status: 'archived', updatedAt: new Date().toISOString() } })
      notify({ title: `"${item.title}" archived`, type: 'success' })
    },
    [update],
  )

  const handleSnoozeStale = useCallback(
    (item: Entity) => {
      update.mutate({ id: item.id, updates: { updatedAt: new Date().toISOString() } })
      notify({ title: `"${item.title}" snoozed for ${STALE_DAYS} days`, type: 'success' })
    },
    [update],
  )

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

  const reviewDue = useMemo(() => !isReviewDoneThisWeek(), [])

  // Deep Work stats
  const focusStatsData = useMemo(() => {
    const titleMap = new Map(allEntities.map((e) => [e.id, e.title]))
    return calcFocusStats(allTrackers, titleMap)
  }, [allTrackers, allEntities])

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

  const handleHabitCheckIn = useCallback(
    (habit: Entity) => {
      createTracker.mutate({
        id: crypto.randomUUID(),
        entityId: habit.id,
        value: 1,
        unit: 'done',
        timestamp: new Date().toISOString(),
        ownerId: currentUser?.id ?? '',
      })
      const currentStreak = typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0
      update.mutate({
        id: habit.id,
        updates: {
          metadata: { ...habit.metadata, streak: currentStreak + 1 },
          updatedAt: new Date().toISOString(),
        },
      })
      notify({ title: `${habit.title} done!`, type: 'success' })
    },
    [createTracker, update, currentUser],
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

  const handleJournalSave = useCallback(() => {
    if (!journalText.trim()) return
    create.mutate({
      id: crypto.randomUUID(),
      type: 'note',
      title: `Journal — ${new Date().toLocaleDateString()}`,
      status: 'todo',
      priority: 'low',
      tags: ['journal'],
      metadata: { body: journalText.trim(), isJournal: true, date: today, mood: '' },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    setJournalText('')
    setShowJournal(false)
    notify({ title: 'Journal saved', type: 'success' })
  }, [create, currentUser, today, journalText])

  const handleConvertToTask = useCallback(
    (item: Entity) => {
      create.mutate({
        id: crypto.randomUUID(),
        type: 'task',
        title: item.title,
        description: typeof item.metadata.body === 'string' ? (item.metadata.body as string) : undefined,
        status: 'todo',
        priority: 'medium',
        tags: [],
        metadata: {},
        ownerId: currentUser?.id ?? '',
        visibility: 'private',
        dueDate: today,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      update.mutate({ id: item.id, updates: { status: 'archived', updatedAt: new Date().toISOString() } })
      notify({ title: 'Converted to task', type: 'success' })
    },
    [create, update, currentUser, today],
  )

  const handleArchiveInbox = useCallback(
    (item: Entity) => {
      update.mutate({ id: item.id, updates: { status: 'archived', updatedAt: new Date().toISOString() } })
    },
    [update],
  )

  const dateStr = new Date().toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })

  return (
    <div className="h-[calc(100vh-5rem)] flex flex-col">
      {/* ─── Header ─── */}
      <header className="shrink-0 pb-4 flex items-end justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight truncate">
            {getGreeting()}, {displayName}
          </h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {dateStr} <LiveClock />
          </p>
        </div>
        <div className="flex items-center gap-4">
          {/* Focus Score pill */}
          {focusScore !== null && (
            <div className={`px-3 py-1 rounded-full text-xs font-medium tabular-nums ${
              focusScore >= 100
                ? 'bg-green-500/10 text-green-600 dark:text-green-400'
                : focusScore >= 50
                  ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                  : 'bg-muted text-muted-foreground'
            }`}>
              Focus {focusScore}%
            </div>
          )}
          {/* Day progress */}
          {totalItems > 0 && (
            <div className="flex items-center gap-2 min-w-[120px]">
              <Progress value={totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 100} className="h-1.5 flex-1" />
              <span className="text-[11px] tabular-nums text-muted-foreground">{doneItems}/{totalItems}</span>
            </div>
          )}
        </div>
      </header>

      {/* ─── Capture Bar ─── */}
      <div className="shrink-0 pb-5">
        <CaptureBar />
      </div>

      {/* ─── Main Grid ─── */}
      <div className="flex-1 min-h-0 grid grid-cols-1 lg:grid-cols-12 gap-6">

        {/* ═══ LEFT — Actionable (7/12) ═══ */}
        <div className="lg:col-span-7 min-h-0 overflow-y-auto space-y-6 pr-1 scrollbar-thin">

          {/* Today Focus — story-based */}
          <section>
            {priorities.length > 0 ? (
              <>
                <SH action={
                  <div className="flex items-center gap-2">
                    <button
                      className="flex items-center gap-1 text-[11px] font-medium text-amber-600 dark:text-amber-400 hover:text-amber-700 dark:hover:text-amber-300 transition-colors"
                      onClick={() => {
                        const store = useFocusStore.getState()
                        // Resume existing session if same tasks, otherwise start new
                        const same = store.emperorEntityIds.length === priorities.length &&
                          priorities.every((id) => store.emperorEntityIds.includes(id))
                        if (!same || !store.sessionId) {
                          store.startEmperorTime(priorities)
                        }
                        navigate('/deep-work')
                      }}
                    >
                      <Crown className="h-3 w-3" />
                      Emperor Time
                    </button>
                    <span className="text-muted-foreground/20">|</span>
                    <button
                      className="text-[11px] text-muted-foreground/50 hover:text-foreground transition-colors"
                      onClick={() => { setTodayPriorities([]); setPriorities([]) }}
                    >
                      Reset
                    </button>
                  </div>
                }>
                  <Target className="h-3 w-3 inline mr-1.5 -mt-px" />
                  Today Focus
                </SH>
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

                    // ── Goal → clickable link to goal detail ──
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

                    // ── Task (no subtasks) → checkbox ──
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

                    // ── Story (task with subtasks) → collapsible checklist ──
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

                {/* Add to focus */}
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
              </>
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

          {/* Inbox */}
          {inboxItems.length > 0 && (
            <section>
              <SH>
                <Inbox className="h-3 w-3 inline mr-1.5 -mt-px" />
                Inbox ({inboxItems.length})
              </SH>
              <div className="space-y-0.5">
                {inboxItems.slice(0, 8).map((item) => (
                  <div key={item.id} className="flex items-center gap-3 py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors group">
                    <span className="text-sm flex-1 truncate">{item.title}</span>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => handleConvertToTask(item)}>
                        <ArrowRight className="h-3 w-3 mr-1" /> Task
                      </Button>
                      <Button size="sm" variant="ghost" className="h-6 px-2 text-[11px]" onClick={() => handleArchiveInbox(item)}>
                        Done
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Journal — collapsed */}
          <section className="pb-6">
            <button
              onClick={() => setShowJournal((v) => !v)}
              className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            >
              <BookOpen className="h-3 w-3" />
              Quick Journal
              <ChevronRight className={`h-3 w-3 transition-transform ${showJournal ? 'rotate-90' : ''}`} />
            </button>
            {showJournal && (
              <div className="mt-3 space-y-2">
                <Textarea
                  placeholder="What's on your mind?"
                  rows={3}
                  value={journalText}
                  onChange={(e) => setJournalText(e.target.value)}
                  className="resize-none"
                  autoFocus
                />
                <Button size="sm" disabled={!journalText.trim()} onClick={handleJournalSave}>Save</Button>
              </div>
            )}
          </section>
        </div>

        {/* ═══ RIGHT — Quick Summary (5/12) ═══ */}
        <aside className="lg:col-span-5 min-h-0 overflow-y-auto space-y-1 scrollbar-thin">

          {/* Header with standup button */}
          <div className="flex items-center justify-between px-4 pb-1">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">Quick Summary</h2>
            <button
              onClick={() => setStandupOpen(true)}
              className="text-[11px] text-muted-foreground/50 hover:text-foreground transition-colors flex items-center gap-1"
            >
              📋 Summary
            </button>
          </div>

          {/* Calendar — today's tasks, events + iCal */}
          <Collapsible defaultOpen>
            <CollapsibleTrigger className="flex items-center gap-2 w-full py-2.5 px-4 rounded-lg hover:bg-muted/30 transition-colors text-left">
              <span className="text-sm">📅</span>
              <span className="text-sm flex-1 font-medium">Calendar</span>
              <span className="text-[11px] text-muted-foreground/50 tabular-nums">{todayTasks.length + todayEvents.length + todayICalEvents.length}</span>
              <ChevronRight className="h-3 w-3 text-muted-foreground/30 transition-transform [[data-state=open]>&]:rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-4 pb-3 space-y-1">
                {todayTasks.length === 0 && todayEvents.length === 0 && todayICalEvents.length === 0 ? (
                  <p className="text-xs text-muted-foreground/40 py-1">Nothing scheduled today</p>
                ) : (
                  <>
                    {/* Tasks due today */}
                    {todayTasks.map((task) => (
                      <div key={task.id} className="flex items-center gap-2.5 py-1.5">
                        <span className="text-[11px] tabular-nums text-muted-foreground/50 w-12 shrink-0">Task</span>
                        <span className="w-1.5 h-1.5 rounded-full bg-cyan-500/60 shrink-0" />
                        <span className={`text-sm truncate flex-1 ${task.status === 'done' ? 'line-through text-muted-foreground/40' : ''}`}>{task.title}</span>
                        {typeof task.metadata.workspace === 'string' && (
                          <span className="text-[10px] text-muted-foreground/30">{task.metadata.workspace === 'work' ? '🏢' : '🏠'}</span>
                        )}
                      </div>
                    ))}
                    {/* Local events */}
                    {todayEvents.map((event) => (
                      <div key={event.id} className="flex items-center gap-2.5 py-1.5">
                        <span className="text-[11px] tabular-nums text-muted-foreground/50 w-12 shrink-0">
                          {(event.metadata.time as string) ?? 'All day'}
                        </span>
                        <span className="w-1.5 h-1.5 rounded-full bg-blue-500/60 shrink-0" />
                        <span className="text-sm truncate">{event.title}</span>
                      </div>
                    ))}
                    {/* iCal / Google Calendar events */}
                    {todayICalEvents.map((event) => (
                      <div key={event.id} className="flex items-center gap-2.5 py-1.5">
                        <span className="text-[11px] tabular-nums text-muted-foreground/50 w-12 shrink-0">
                          {event.isAllDay ? 'All day' : event.start.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: event.color || '#7986cb' }} />
                        <span className="text-sm truncate">{event.title}</span>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Deep Work Log */}
          <Collapsible defaultOpen={false}>
            <CollapsibleTrigger className="flex items-center gap-2 w-full py-2.5 px-4 rounded-lg hover:bg-muted/30 transition-colors text-left">
              <span className="text-sm">🎯</span>
              <span className="text-sm flex-1 font-medium">Deep Work</span>
              <span className="text-[11px] text-muted-foreground/50 tabular-nums">{formatMinutes(focusStatsData.todayMinutes)}</span>
              <ChevronRight className="h-3 w-3 text-muted-foreground/30 transition-transform [[data-state=open]>&]:rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-4 pb-3 space-y-3">
                {/* Today */}
                <p className="text-xs text-muted-foreground">
                  Today: {focusStatsData.todaySessions} session{focusStatsData.todaySessions !== 1 ? 's' : ''} · {formatMinutes(focusStatsData.todayMinutes)}
                </p>

                {/* Weekly bar chart */}
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-muted-foreground/50">This Week</span>
                    <span className="text-[10px] text-muted-foreground/50 tabular-nums">
                      {formatMinutes(focusStatsData.thisWeekMinutes)}
                      {focusStatsData.weekDiff !== 0 && (
                        <span className={focusStatsData.weekDiff > 0 ? ' text-green-500' : ' text-red-500'}>
                          {' '}{focusStatsData.weekDiff > 0 ? '+' : ''}{formatMinutes(Math.abs(focusStatsData.weekDiff))}
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="flex items-end gap-1 h-10">
                    {focusStatsData.weekDays.map((day) => {
                      const maxMin = Math.max(1, ...focusStatsData.weekDays.map((d) => d.minutes))
                      const heightPct = day.minutes > 0 ? Math.max(10, (day.minutes / maxMin) * 100) : 0
                      const isToday = day.date === today
                      return (
                        <div key={day.date} className="flex-1 flex flex-col items-center gap-0.5">
                          <div
                            className={`w-full rounded-sm transition-all ${
                              isToday ? 'bg-primary' : day.minutes > 0 ? 'bg-primary/40' : 'bg-muted/30'
                            }`}
                            style={{ height: `${heightPct}%`, minHeight: day.minutes > 0 ? 3 : 1 }}
                          />
                          <span className={`text-[9px] ${isToday ? 'text-foreground font-medium' : 'text-muted-foreground/40'}`}>
                            {day.label.charAt(0)}
                          </span>
                        </div>
                      )
                    })}
                  </div>
                </div>

                {/* Top tasks */}
                {focusStatsData.topTasks.length > 0 && (
                  <div className="space-y-1">
                    <p className="text-[10px] text-muted-foreground/50">Top Focus</p>
                    {focusStatsData.topTasks.slice(0, 3).map((task) => {
                      const maxMin = Math.max(1, ...focusStatsData.topTasks.map((t) => t.minutes))
                      return (
                        <div key={task.entityId} className="space-y-0.5">
                          <div className="flex justify-between text-xs">
                            <span className="truncate pr-2">{task.title}</span>
                            <span className="text-muted-foreground/50 tabular-nums shrink-0">{formatMinutes(task.minutes)}</span>
                          </div>
                          <div className="h-1 bg-muted/30 rounded-full overflow-hidden">
                            <div className="h-full bg-primary/50 rounded-full" style={{ width: `${(task.minutes / maxMin) * 100}%` }} />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Streak */}
                {focusStatsData.streak > 0 && (
                  <p className="text-xs flex items-center gap-1">
                    <span>🔥</span>
                    <span className="font-medium">{focusStatsData.streak} day streak</span>
                  </p>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Tasks — due today count */}
          <Collapsible defaultOpen={false}>
            <CollapsibleTrigger className="flex items-center gap-2 w-full py-2.5 px-4 rounded-lg hover:bg-muted/30 transition-colors text-left">
              <span className="text-sm">📋</span>
              <span className="text-sm flex-1 font-medium">Tasks</span>
              <span className="text-[11px] text-muted-foreground/50 tabular-nums">{todayTasks.length} due</span>
              <ChevronRight className="h-3 w-3 text-muted-foreground/30 transition-transform [[data-state=open]>&]:rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-4 pb-3 space-y-1">
                {todayTasks.length === 0 ? (
                  <p className="text-xs text-muted-foreground/40 py-1">No tasks due today</p>
                ) : (
                  todayTasks.slice(0, 8).map((task) => (
                    <div key={task.id} className="flex items-center gap-2.5 py-1.5">
                      <Checkbox
                        checked={task.status === 'done'}
                        onCheckedChange={() => toggleItem(task)}
                        className="h-3.5 w-3.5 shrink-0"
                      />
                      <span className={`text-sm truncate flex-1 ${task.status === 'done' ? 'line-through text-muted-foreground/50' : ''}`}>{task.title}</span>
                      {typeof task.metadata.workspace === 'string' && (
                        <span className="text-[10px] text-muted-foreground/30">{task.metadata.workspace === 'work' ? '🏢' : '🏠'}</span>
                      )}
                    </div>
                  ))
                )}
                {todayTasks.length > 8 && (
                  <button onClick={() => navigate('/tasks')} className="text-xs text-primary/60 hover:text-primary transition-colors pt-1">
                    +{todayTasks.length - 8} more →
                  </button>
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Goals — active with progress */}
          <Collapsible defaultOpen={false}>
            <CollapsibleTrigger className="flex items-center gap-2 w-full py-2.5 px-4 rounded-lg hover:bg-muted/30 transition-colors text-left">
              <span className="text-sm">🎯</span>
              <span className="text-sm flex-1 font-medium">Goals</span>
              <span className="text-[11px] text-muted-foreground/50 tabular-nums">{activeProjects.length} active</span>
              <ChevronRight className="h-3 w-3 text-muted-foreground/30 transition-transform [[data-state=open]>&]:rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-4 pb-3 space-y-2">
                {activeProjects.length === 0 ? (
                  <p className="text-xs text-muted-foreground/40 py-1">No active goals</p>
                ) : (
                  activeProjects.map((goal) => {
                    const p = typeof goal.metadata.progress === 'number' ? (goal.metadata.progress as number) : 0
                    return (
                      <button key={goal.id} onClick={() => navigate(`/goals?id=${goal.id}`)} className="w-full text-left hover:bg-muted/30 rounded px-1 py-1 transition-colors">
                        <div className="flex justify-between text-sm mb-1">
                          <span className="truncate pr-2">{goal.title}</span>
                          <span className="text-[11px] tabular-nums text-muted-foreground/50 shrink-0">{p}%</span>
                        </div>
                        <Progress value={p} className="h-1" />
                      </button>
                    )
                  })
                )}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Habits */}
          <Collapsible defaultOpen={false}>
            <CollapsibleTrigger className="flex items-center gap-2 w-full py-2.5 px-4 rounded-lg hover:bg-muted/30 transition-colors text-left">
              <span className="text-sm">🔁</span>
              <span className="text-sm flex-1 font-medium">Habits</span>
              <span className="text-[11px] text-muted-foreground/50 tabular-nums">{habitsChecked}/{habits.length}</span>
              <ChevronRight className="h-3 w-3 text-muted-foreground/30 transition-transform [[data-state=open]>&]:rotate-90" />
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="px-4 pb-3 flex flex-wrap gap-1.5">
                {habits.map(({ habit, checkedToday, streak }) => (
                  <button
                    key={habit.id}
                    onClick={() => !checkedToday && handleHabitCheckIn(habit)}
                    disabled={checkedToday}
                    className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-md text-xs transition-all ${
                      checkedToday
                        ? 'bg-green-500/10 text-green-700 dark:text-green-400'
                        : 'bg-muted/40 hover:bg-muted text-foreground'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full ${checkedToday ? 'bg-green-500' : 'bg-muted-foreground/20'}`} />
                    {habit.title}
                    {streak > 0 && <span className="text-[10px] text-muted-foreground/40 tabular-nums">{streak}d</span>}
                  </button>
                ))}
              </div>
            </CollapsibleContent>
          </Collapsible>

          {/* Stale Items */}
          {staleItems.length > 0 && (
            <Collapsible defaultOpen={false}>
              <CollapsibleTrigger className="flex items-center gap-2 w-full py-2.5 px-4 rounded-lg hover:bg-muted/30 transition-colors text-left">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-500" />
                <span className="text-sm flex-1 font-medium">Stale</span>
                <span className="text-[11px] text-amber-500/70 tabular-nums">{staleItems.length}</span>
                <ChevronRight className="h-3 w-3 text-muted-foreground/30 transition-transform [[data-state=open]>&]:rotate-90" />
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="px-4 pb-3 space-y-1">
                  {staleItems.slice(0, 10).map((item) => (
                    <div key={item.id} className="flex items-center gap-2 py-1.5 group">
                      <span className="text-sm flex-1 truncate">{item.title}</span>
                      <span className="text-[10px] text-muted-foreground/40 flex items-center gap-0.5 shrink-0">
                        <CalendarClock className="h-2.5 w-2.5" />
                        {daysAgo(item.updatedAt)}d
                      </span>
                      <span className="text-[10px] text-muted-foreground/30 capitalize shrink-0">{item.type}</span>
                      <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                        <button
                          onClick={() => handleSnoozeStale(item)}
                          className="p-1 rounded hover:bg-muted transition-colors"
                          title="Snooze — reset timer"
                        >
                          <RotateCcw className="h-3 w-3 text-muted-foreground" />
                        </button>
                        <button
                          onClick={() => handleArchiveStale(item)}
                          className="p-1 rounded hover:bg-muted transition-colors"
                          title="Archive"
                        >
                          <Archive className="h-3 w-3 text-muted-foreground" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {staleItems.length > 10 && (
                    <button onClick={() => navigate('/review')} className="text-xs text-primary/60 hover:text-primary transition-colors pt-1">
                      +{staleItems.length - 10} more → Review
                    </button>
                  )}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )}

          {/* Weekly Review nudge */}
          {reviewDue && (
            <button
              onClick={() => navigate('/review')}
              className="w-full rounded-lg border border-dashed border-primary/20 p-3 mt-2 text-left hover:bg-muted/30 transition-colors flex items-center gap-3"
            >
              <div className="flex-1">
                <p className="text-sm font-medium">Weekly Review</p>
                <p className="text-[11px] text-muted-foreground/50">Time to reflect on your week</p>
              </div>
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/40" />
            </button>
          )}
        </aside>
      </div>

      {/* Standup Report Sheet */}
      <StandupReport
        open={standupOpen}
        onOpenChange={setStandupOpen}
        tasks={allEntities.filter((e) => e.type === 'task' || e.type === 'chore')}
        todayPriorityIds={priorities}
      />
    </div>
  )
}
