import { useState, useMemo } from 'react'
import {
  Crosshair,
  CalendarClock,
  TrendingDown,
  AlertTriangle,
  Lock,
  Unlock,
  Star,
} from 'lucide-react'
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
} from '@dnd-kit/core'
import { useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useEntities } from '@/core/hooks'
import { useWeeklyPlan, type WeeklyOutcome } from '@/hooks/use-weekly-plan'
import { useICalEvents } from '@/hooks/use-ical-events'
import type { Entity } from '@/core/types'

// ─── Priority styling ───

const PRIORITY_DOT: Record<string, string> = {
  urgent: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-blue-500',
  low: 'bg-zinc-500',
}

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// ─── Draggable task pill ───

function TaskPill({ entity, isDragging }: { entity: Entity; isDragging?: boolean }) {
  const dueThisWeek = entity.dueDate && new Date(entity.dueDate) <= new Date(Date.now() + 7 * 86400000)
  return (
    <div className={`flex items-center gap-1.5 px-2 py-1 rounded-md text-xs transition-colors ${
      isDragging ? 'bg-primary/20 border border-primary/40 shadow-lg' : 'bg-muted/50 hover:bg-muted border border-transparent'
    }`}>
      <div className={`w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_DOT[entity.priority] ?? PRIORITY_DOT.medium}`} />
      <span className="truncate">{entity.title}</span>
      {dueThisWeek && <Badge variant="outline" className="text-[9px] px-1 py-0 shrink-0 border-amber-500/30 text-amber-500">due</Badge>}
    </div>
  )
}

function SortableTaskPill({ entity }: { entity: Entity }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: entity.id })
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`cursor-grab active:cursor-grabbing ${isDragging ? 'opacity-50' : ''}`}
      {...attributes}
      {...listeners}
    >
      <TaskPill entity={entity} />
    </div>
  )
}

// ─── Main Component ───

export function StepWeeklyPlan() {
  const { items: entities } = useEntities()
  const { events: icalEvents } = useICalEvents()
  const {
    plan,
    currentMonday,
    weekDates,
    allocatedIds,
    createPlan,
    setOutcomes,
    allocateTask,
    unallocateTask,
    lockPlan,
    unlockPlan,
  } = useWeeklyPlan()

  const [showWeekend, setShowWeekend] = useState(false)
  const [dragEntity, setDragEntity] = useState<Entity | null>(null)
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }))

  // Outcome draft state
  const [draftOutcomes, setDraftOutcomes] = useState<string[]>(() =>
    plan?.outcomes.map((o) => o.text) ?? ['', '', ''],
  )

  // ─── Intel briefing data ───

  const openTasks = useMemo(
    () => entities.filter((e) =>
      (e.type === 'task' || e.type === 'chore') &&
      e.status !== 'done' && e.status !== 'archived',
    ),
    [entities],
  )

  const carriedFromLastWeek = useMemo(() => {
    const lastMonday = new Date(currentMonday + 'T00:00:00')
    lastMonday.setDate(lastMonday.getDate() - 7)
    const lastMondayStr = lastMonday.toISOString().split('T')[0]
    return openTasks.filter((e) => e.createdAt.split('T')[0] < lastMondayStr)
  }, [openTasks, currentMonday])

  const deadlinesThisWeek = useMemo(() => {
    const end = new Date(currentMonday + 'T00:00:00')
    end.setDate(end.getDate() + 7)
    const endStr = end.toISOString().split('T')[0]
    return openTasks.filter((e) => e.dueDate && e.dueDate >= currentMonday && e.dueDate < endStr)
  }, [openTasks, currentMonday])

  const velocityGaps = useMemo(() => {
    const projects = entities.filter((e) => e.type === 'project' && e.status === 'in-progress')
    const tasks = entities.filter((e) => e.type === 'task')
    const now = Date.now()
    const weekStart = new Date(now - 7 * 86400000).toISOString()
    const twoWeeksAgo = new Date(now - 14 * 86400000).toISOString()
    const gaps: { title: string; thisWeek: number; lastWeek: number }[] = []
    for (const p of projects) {
      const pt = tasks.filter((t) => t.metadata?.projectId === p.id)
      const tw = pt.filter((t) => t.status === 'done' && t.updatedAt >= weekStart).length
      const lw = pt.filter((t) => t.status === 'done' && t.updatedAt >= twoWeeksAgo && t.updatedAt < weekStart).length
      if (lw > 0 && tw < lw) gaps.push({ title: p.title, thisWeek: tw, lastWeek: lw })
    }
    return gaps
  }, [entities])

  const calendarLoad = useMemo(() => {
    const weekEnd = new Date(currentMonday + 'T00:00:00')
    weekEnd.setDate(weekEnd.getDate() + 7)
    const weekEvents = icalEvents.filter((e) => e.start >= new Date(currentMonday) && e.start < weekEnd)
    const totalHours = weekEvents.reduce((sum, e) => {
      if (e.isAllDay) return sum + 8
      const mins = (e.end.getTime() - e.start.getTime()) / 60000
      return sum + mins / 60
    }, 0)
    return { count: weekEvents.length, hours: Math.round(totalHours) }
  }, [icalEvents, currentMonday])

  // ─── Unallocated pool ───

  const unallocatedTasks = useMemo(() => {
    const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 }
    return openTasks
      .filter((e) => !allocatedIds.has(e.id))
      .sort((a, b) => {
        // Due date first, then priority
        if (a.dueDate && !b.dueDate) return -1
        if (!a.dueDate && b.dueDate) return 1
        return (priorityOrder[a.priority] ?? 2) - (priorityOrder[b.priority] ?? 2)
      })
      .slice(0, 30) // cap for performance
  }, [openTasks, allocatedIds])

  // ─── Handlers ───

  const handleSaveOutcomes = () => {
    const outcomes: WeeklyOutcome[] = draftOutcomes
      .filter((t) => t.trim())
      .map((text, i) => ({
        id: plan?.outcomes[i]?.id ?? crypto.randomUUID(),
        text: text.trim(),
        linkedEntityIds: plan?.outcomes[i]?.linkedEntityIds ?? [],
        status: plan?.outcomes[i]?.status ?? 'open',
      }))
    setOutcomes(outcomes)
  }

  const handleDragStart = (event: DragStartEvent) => {
    const entity = [...openTasks, ...unallocatedTasks].find((e) => e.id === event.active.id)
    setDragEntity(entity ?? null)
  }

  const handleDragEnd = (event: DragEndEvent) => {
    setDragEntity(null)
    const { active, over } = event
    if (!over) return
    const targetId = String(over.id)
    // Dropped on a day column
    if (targetId.startsWith('day-')) {
      const date = targetId.replace('day-', '')
      allocateTask(date, String(active.id))
    }
    // Dropped on pool
    if (targetId === 'pool') {
      unallocateTask(String(active.id))
    }
  }

  // Ensure plan exists
  if (!plan) {
    return (
      <div className="text-center py-16 space-y-4">
        <Crosshair className="h-10 w-10 mx-auto text-muted-foreground/30" />
        <p className="text-sm text-muted-foreground">No plan for this week yet.</p>
        <Button onClick={createPlan} className="gap-2">
          <Star className="h-4 w-4" />
          Start Weekly Plan
        </Button>
      </div>
    )
  }

  const visibleDays = showWeekend ? 7 : 5

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold flex items-center gap-2">
            <Crosshair className="h-4 w-4 text-primary" />
            Week of {new Date(currentMonday + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
          </h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowWeekend(!showWeekend)}
              className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
            >
              {showWeekend ? 'Hide weekend' : 'Show weekend'}
            </button>
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={plan.locked ? unlockPlan : lockPlan}
            >
              {plan.locked ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
              {plan.locked ? 'Unlock' : 'Lock Plan'}
            </Button>
          </div>
        </div>

        {/* Intel Briefing */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <IntelCard
            icon={<AlertTriangle className="h-3.5 w-3.5 text-amber-500" />}
            label="Carried"
            value={carriedFromLastWeek.length}
            detail="from last week"
          />
          <IntelCard
            icon={<CalendarClock className="h-3.5 w-3.5 text-blue-500" />}
            label="Deadlines"
            value={deadlinesThisWeek.length}
            detail="this week"
          />
          <IntelCard
            icon={<TrendingDown className="h-3.5 w-3.5 text-red-500" />}
            label="Velocity gaps"
            value={velocityGaps.length}
            detail={velocityGaps.length > 0 ? velocityGaps[0].title : 'all healthy'}
          />
          <IntelCard
            icon={<CalendarClock className="h-3.5 w-3.5 text-violet-500" />}
            label="Calendar"
            value={`${calendarLoad.hours}h`}
            detail={`${calendarLoad.count} events`}
          />
        </div>

        {/* Three Stars */}
        <section>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-2 block">
            <Star className="h-3 w-3 inline mr-1 -mt-px text-amber-500" />
            Three Stars — Weekly Outcomes
          </label>
          <div className="space-y-2">
            {[0, 1, 2].map((i) => (
              <input
                key={i}
                type="text"
                value={draftOutcomes[i] ?? ''}
                onChange={(e) => {
                  const next = [...draftOutcomes]
                  next[i] = e.target.value
                  setDraftOutcomes(next)
                }}
                onBlur={handleSaveOutcomes}
                placeholder={`Outcome ${i + 1}`}
                disabled={plan.locked}
                className="w-full bg-transparent border border-border/50 rounded-lg px-3 py-2 text-sm placeholder:text-muted-foreground/30 focus:outline-none focus:border-primary/40 disabled:opacity-50"
              />
            ))}
          </div>
        </section>

        {/* Allocation Grid */}
        <section>
          <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-2 block">
            Task Allocation
          </label>
          <div className={`grid gap-2`} style={{ gridTemplateColumns: `repeat(${visibleDays}, 1fr)` }}>
            {weekDates.slice(0, visibleDays).map((date, i) => {
              const dayTasks = (plan.allocations.find((a) => a.date === date)?.entityIds ?? [])
                .map((id) => entities.find((e) => e.id === id))
                .filter(Boolean) as Entity[]
              const isToday = date === new Date().toISOString().split('T')[0]
              return (
                <DayColumn
                  key={date}
                  date={date}
                  label={DAY_LABELS[i]}
                  tasks={dayTasks}
                  isToday={isToday}
                  locked={plan.locked}
                />
              )
            })}
          </div>
        </section>

        {/* Unallocated Pool */}
        {!plan.locked && (
          <section>
            <label className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50 mb-2 block">
              Unallocated ({unallocatedTasks.length})
            </label>
            <DroppablePool id="pool">
              <div className="flex flex-wrap gap-1.5">
                {unallocatedTasks.slice(0, 20).map((entity) => (
                  <SortableTaskPill key={entity.id} entity={entity} />
                ))}
                {unallocatedTasks.length === 0 && (
                  <p className="text-xs text-muted-foreground/30 py-2">All tasks allocated</p>
                )}
              </div>
            </DroppablePool>
          </section>
        )}
      </div>

      <DragOverlay>
        {dragEntity && <TaskPill entity={dragEntity} isDragging />}
      </DragOverlay>
    </DndContext>
  )
}

// ─── Sub-components ───

function IntelCard({ icon, label, value, detail }: { icon: React.ReactNode; label: string; value: string | number; detail: string }) {
  return (
    <div className="rounded-lg border bg-muted/30 px-3 py-2">
      <div className="flex items-center gap-1.5 mb-1">
        {icon}
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground/50">{label}</span>
      </div>
      <p className="text-lg font-semibold">{value}</p>
      <p className="text-[10px] text-muted-foreground/40 truncate">{detail}</p>
    </div>
  )
}

function DroppablePool({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef, isOver } = useSortable({ id })
  return (
    <div
      ref={setNodeRef}
      className={`min-h-[48px] rounded-lg border border-dashed p-2 transition-colors ${
        isOver ? 'border-primary/50 bg-primary/5' : 'border-border/30'
      }`}
    >
      {children}
    </div>
  )
}

function DayColumn({ date, label, tasks, isToday, locked }: {
  date: string
  label: string
  tasks: Entity[]
  isToday: boolean
  locked: boolean
}) {
  const { setNodeRef, isOver } = useSortable({ id: `day-${date}` })
  return (
    <div
      ref={setNodeRef}
      className={`rounded-lg border p-2 min-h-[100px] transition-colors ${
        isToday ? 'border-primary/40 bg-primary/5' : 'border-border/30'
      } ${isOver && !locked ? 'border-primary/50 bg-primary/10' : ''}`}
    >
      <p className={`text-[10px] font-semibold uppercase tracking-wider mb-2 ${
        isToday ? 'text-primary' : 'text-muted-foreground/50'
      }`}>
        {label}
        <span className="font-normal ml-1">{new Date(date + 'T00:00:00').getDate()}</span>
      </p>
      <div className="space-y-1">
        {tasks.map((entity) => (
          locked
            ? <TaskPill key={entity.id} entity={entity} />
            : <SortableTaskPill key={entity.id} entity={entity} />
        ))}
      </div>
    </div>
  )
}
