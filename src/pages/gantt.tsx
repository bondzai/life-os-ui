import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router'
import { Gantt, ViewMode, type Task } from 'gantt-task-react'
import 'gantt-task-react/dist/index.css'
import { GanttChart as GanttIcon } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EmptyState } from '@/core/components/empty-state'
import { useEntities, useRelations } from '@/core/hooks'
import type { Entity } from '@/core/types'

/* ─── Types ─── */

type GroupBy = 'project' | 'goal' | 'none'

const VIEW_MODES: { label: string; value: ViewMode }[] = [
  { label: 'Day', value: ViewMode.Day },
  { label: 'Week', value: ViewMode.Week },
  { label: 'Month', value: ViewMode.Month },
]

/* ─── Status → color ─── */

const statusColor: Record<string, string> = {
  todo: '#3b82f6',
  'in-progress': '#f59e0b',
  done: '#10b981',
  backlog: '#9ca3af',
  archived: '#6b7280',
}

const statusProgress: Record<string, number> = {
  todo: 0,
  'in-progress': 50,
  done: 100,
  backlog: 0,
  archived: 100,
}

/* ─── Helpers ─── */

function safeDate(dateStr: string | undefined, fallback: Date): Date {
  if (!dateStr) return fallback
  const d = new Date(dateStr)
  return isNaN(d.getTime()) ? fallback : d
}

function endOfDay(d: Date): Date {
  const r = new Date(d)
  r.setHours(23, 59, 59, 999)
  return r
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

/* ─── Page ─── */

export function GanttPage() {
  const { items: entities } = useEntities()
  const { items: relations } = useRelations()
  const navigate = useNavigate()

  const [viewMode, setViewMode] = useState<ViewMode>(ViewMode.Week)
  const [groupBy, setGroupBy] = useState<GroupBy>('project')

  const tasks = useMemo((): Task[] => {
    const now = new Date()
    const result: Task[] = []

    const allTasks = entities.filter(
      (e) => e.type === 'task' && e.status !== 'archived',
    )
    const allProjects = entities.filter(
      (e) => e.type === 'project' && e.status !== 'archived',
    )
    const allGoals = entities.filter(
      (e) => e.type === 'goal' && e.status !== 'archived',
    )

    // Build dependency map from 'blocks' relations
    const deps = new Map<string, string[]>()
    for (const r of relations) {
      if (r.type === 'blocks') {
        const existing = deps.get(r.toId) ?? []
        existing.push(r.fromId)
        deps.set(r.toId, existing)
      }
    }

    function entityToTask(e: Entity, project?: string): Task {
      const start = safeDate(e.createdAt, now)
      const end = e.dueDate ? endOfDay(safeDate(e.dueDate, addDays(start, 7))) : endOfDay(addDays(start, 7))
      // Ensure end > start
      const safeEnd = end.getTime() <= start.getTime() ? endOfDay(addDays(start, 1)) : end

      return {
        id: e.id,
        name: e.title,
        start,
        end: safeEnd,
        progress: statusProgress[e.status] ?? 0,
        type: 'task',
        project,
        dependencies: deps.get(e.id) ?? [],
        styles: {
          backgroundColor: statusColor[e.status] ?? '#3b82f6',
          backgroundSelectedColor: statusColor[e.status] ?? '#3b82f6',
          progressColor: '#ffffff40',
          progressSelectedColor: '#ffffff60',
        },
      }
    }

    function groupToTask(e: Entity, type: 'project'): Task {
      // Find date range from children
      const children = allTasks.filter((t) =>
        type === 'project' ? t.metadata?.projectId === e.id : t.metadata?.goalId === e.id,
      )
      const start = safeDate(e.createdAt, now)
      const childEnds = children
        .map((c) => (c.dueDate ? safeDate(c.dueDate, start) : addDays(start, 14)))
        .filter((d) => !isNaN(d.getTime()))
      const end = childEnds.length > 0
        ? endOfDay(new Date(Math.max(...childEnds.map((d) => d.getTime()))))
        : endOfDay(addDays(start, 30))
      const safeEnd = end.getTime() <= start.getTime() ? endOfDay(addDays(start, 7)) : end

      const doneCount = children.filter((c) => c.status === 'done').length
      const progress = children.length > 0 ? Math.round((doneCount / children.length) * 100) : 0

      return {
        id: e.id,
        name: e.title,
        start,
        end: safeEnd,
        progress,
        type: 'project',
        hideChildren: false,
        styles: {
          backgroundColor: statusColor[e.status] ?? '#6366f1',
          backgroundSelectedColor: statusColor[e.status] ?? '#6366f1',
          progressColor: '#ffffff40',
          progressSelectedColor: '#ffffff60',
        },
      }
    }

    if (groupBy === 'project') {
      for (const project of allProjects) {
        result.push(groupToTask(project, 'project'))
        const projectTasks = allTasks.filter((t) => t.metadata?.projectId === project.id)
        for (const t of projectTasks) {
          result.push(entityToTask(t, project.id))
        }
      }
      // Orphan tasks (no project)
      const orphans = allTasks.filter(
        (t) => !t.metadata?.projectId || !allProjects.some((p) => p.id === t.metadata?.projectId),
      )
      if (orphans.length > 0) {
        result.push({
          id: '__orphan__',
          name: 'Ungrouped',
          start: now,
          end: endOfDay(addDays(now, 30)),
          progress: 0,
          type: 'project',
          hideChildren: false,
          styles: { backgroundColor: '#6b7280', backgroundSelectedColor: '#6b7280' },
        })
        for (const t of orphans) {
          result.push(entityToTask(t, '__orphan__'))
        }
      }
    } else if (groupBy === 'goal') {
      for (const goal of allGoals) {
        result.push(groupToTask(goal, 'project'))
        const goalTasks = allTasks.filter((t) => t.metadata?.goalId === goal.id)
        for (const t of goalTasks) {
          result.push(entityToTask(t, goal.id))
        }
      }
      const orphans = allTasks.filter(
        (t) => !t.metadata?.goalId || !allGoals.some((g) => g.id === t.metadata?.goalId),
      )
      if (orphans.length > 0) {
        result.push({
          id: '__orphan__',
          name: 'Ungrouped',
          start: now,
          end: endOfDay(addDays(now, 30)),
          progress: 0,
          type: 'project',
          hideChildren: false,
          styles: { backgroundColor: '#6b7280', backgroundSelectedColor: '#6b7280' },
        })
        for (const t of orphans) {
          result.push(entityToTask(t, '__orphan__'))
        }
      }
    } else {
      // Flat: all tasks sorted by date
      const sorted = [...allTasks].sort((a, b) => {
        const da = a.dueDate ?? a.createdAt
        const db = b.dueDate ?? b.createdAt
        return da.localeCompare(db)
      })
      for (const t of sorted) {
        result.push(entityToTask(t))
      }
    }

    return result
  }, [entities, relations, groupBy])

  const handleClick = (task: Task) => {
    if (task.id === '__orphan__') return
    const entity = entities.find((e) => e.id === task.id)
    if (!entity) return
    if (entity.type === 'project') navigate(`/projects?id=${entity.id}`)
    else if (entity.type === 'goal') navigate(`/goals?id=${entity.id}`)
    else navigate(`/tasks?id=${entity.id}`)
  }

  if (tasks.length === 0) {
    return (
      <div className="p-8">
        <EmptyState
          icon={GanttIcon}
          title="No timeline data"
          description="Create tasks with due dates to see your timeline."
        />
      </div>
    )
  }

  return (
    <div className="h-[calc(100vh-5rem)] flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <GanttIcon className="h-5 w-5 text-muted-foreground" />
          Timeline
        </h1>
        <div className="flex items-center gap-2">
          {/* View mode */}
          <div className="inline-flex items-center rounded-lg bg-muted p-0.5">
            {VIEW_MODES.map((vm) => (
              <button
                key={vm.value}
                onClick={() => setViewMode(vm.value)}
                className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  viewMode === vm.value
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {vm.label}
              </button>
            ))}
          </div>
          {/* Group by */}
          <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
            <SelectTrigger className="w-[130px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project">By Project</SelectItem>
              <SelectItem value="goal">By Goal</SelectItem>
              <SelectItem value="none">Flat</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Gantt chart */}
      <div className="flex-1 overflow-auto">
        <Gantt
          tasks={tasks}
          viewMode={viewMode}
          onClick={handleClick}
          listCellWidth=""
          columnWidth={viewMode === ViewMode.Day ? 60 : viewMode === ViewMode.Week ? 150 : 300}
          barCornerRadius={4}
          barFill={60}
          fontSize="12"
          rowHeight={40}
          headerHeight={50}
          todayColor="rgba(239, 68, 68, 0.08)"
        />
      </div>
    </div>
  )
}
