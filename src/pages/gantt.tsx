import { useState, useMemo, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import FrappeGantt from 'frappe-gantt'
import 'frappe-gantt/dist/frappe-gantt.css'
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

type ViewModeKey = 'Day' | 'Week' | 'Month'
type GroupBy = 'project' | 'goal' | 'none'

interface ChartTask {
  id: string
  name: string
  start: string
  end: string
  progress: number
  dependencies: string
  custom_class: string
}

/* ─── Status → CSS class ─── */

const statusClass: Record<string, string> = {
  todo: 'gantt-bar-todo',
  'in-progress': 'gantt-bar-wip',
  done: 'gantt-bar-done',
  backlog: 'gantt-bar-backlog',
}

const statusProgress: Record<string, number> = {
  todo: 0,
  'in-progress': 50,
  done: 100,
  backlog: 0,
}

/* ─── Helpers ─── */

function formatDate(d: Date): string {
  return d.toISOString().split('T')[0]
}

function safeDate(dateStr: string | undefined, fallback: Date): Date {
  if (!dateStr) return fallback
  const d = new Date(dateStr)
  return isNaN(d.getTime()) ? fallback : d
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d)
  r.setDate(r.getDate() + n)
  return r
}

/* ─── Custom styles ─── */

const GANTT_STYLES = `
.gantt-bar-todo .bar { fill: #3b82f6 !important; }
.gantt-bar-todo .bar-progress { fill: #60a5fa !important; }
.gantt-bar-wip .bar { fill: #f59e0b !important; }
.gantt-bar-wip .bar-progress { fill: #fbbf24 !important; }
.gantt-bar-done .bar { fill: #10b981 !important; }
.gantt-bar-done .bar-progress { fill: #34d399 !important; }
.gantt-bar-backlog .bar { fill: #6b7280 !important; }
.gantt-bar-backlog .bar-progress { fill: #9ca3af !important; }
.gantt-bar-group .bar { fill: #6366f1 !important; opacity: 0.7; }
.gantt-bar-group .bar-progress { fill: #818cf8 !important; }
.gantt .bar-label { fill: #fff !important; font-size: 11px !important; }
.gantt .lower-text, .gantt .upper-text { fill: hsl(var(--muted-foreground)) !important; font-size: 11px !important; }
.gantt .grid-row { fill: transparent !important; }
.gantt .grid-row:nth-child(even) { fill: hsl(var(--muted) / 0.3) !important; }
.gantt .row-line { stroke: hsl(var(--border) / 0.3) !important; }
.gantt .tick { stroke: hsl(var(--border) / 0.2) !important; }
.gantt .today-highlight { fill: rgba(239, 68, 68, 0.06) !important; }
.gantt .arrow { stroke: hsl(var(--muted-foreground) / 0.4) !important; }
`

/* ─── Page ─── */

export function GanttPage() {
  const { items: entities } = useEntities()
  const { items: relations } = useRelations()
  const navigate = useNavigate()
  const ganttRef = useRef<HTMLDivElement>(null)
  const ganttInstanceRef = useRef<FrappeGantt | null>(null)

  const [viewMode, setViewMode] = useState<ViewModeKey>('Week')
  const [groupBy, setGroupBy] = useState<GroupBy>('project')

  // Build Gantt tasks from entities
  const ganttTasks = useMemo((): ChartTask[] => {
    const now = new Date()
    const result: ChartTask[] = []

    const allTasks = entities.filter((e) => e.type === 'task' && e.status !== 'archived')
    const allProjects = entities.filter((e) => e.type === 'project' && e.status !== 'archived')
    const allGoals = entities.filter((e) => e.type === 'goal' && e.status !== 'archived')

    // Dependency map from 'blocks' relations
    const deps = new Map<string, string[]>()
    for (const r of relations) {
      if (r.type === 'blocks') {
        const existing = deps.get(r.toId) ?? []
        existing.push(r.fromId)
        deps.set(r.toId, existing)
      }
    }

    function toGanttTask(e: Entity): ChartTask {
      const start = safeDate(e.createdAt, now)
      const end = e.dueDate ? safeDate(e.dueDate, addDays(start, 7)) : addDays(start, 7)
      const safeEnd = end.getTime() <= start.getTime() ? addDays(start, 1) : end

      return {
        id: e.id,
        name: e.title.length > 40 ? e.title.slice(0, 37) + '...' : e.title,
        start: formatDate(start),
        end: formatDate(safeEnd),
        progress: statusProgress[e.status] ?? 0,
        dependencies: (deps.get(e.id) ?? []).join(', '),
        custom_class: statusClass[e.status] ?? 'gantt-bar-todo',
      }
    }

    function toGroupTask(e: Entity, children: Entity[]): ChartTask {
      const start = safeDate(e.createdAt, now)
      const childEnds = children
        .map((c) => (c.dueDate ? safeDate(c.dueDate, start) : addDays(start, 14)))
      const end = childEnds.length > 0
        ? new Date(Math.max(...childEnds.map((d) => d.getTime())))
        : addDays(start, 30)
      const safeEnd = end.getTime() <= start.getTime() ? addDays(start, 7) : end
      const doneCount = children.filter((c) => c.status === 'done').length
      const progress = children.length > 0 ? Math.round((doneCount / children.length) * 100) : 0

      return {
        id: e.id,
        name: `📁 ${e.title.length > 35 ? e.title.slice(0, 32) + '...' : e.title}`,
        start: formatDate(start),
        end: formatDate(safeEnd),
        progress,
        dependencies: '',
        custom_class: 'gantt-bar-group',
      }
    }

    if (groupBy === 'project') {
      for (const project of allProjects) {
        const children = allTasks.filter((t) => t.metadata?.projectId === project.id)
        result.push(toGroupTask(project, children))
        children.forEach((t) => result.push(toGanttTask(t)))
      }
      const orphans = allTasks.filter(
        (t) => !t.metadata?.projectId || !allProjects.some((p) => p.id === t.metadata?.projectId),
      )
      orphans.forEach((t) => result.push(toGanttTask(t)))
    } else if (groupBy === 'goal') {
      for (const goal of allGoals) {
        const children = allTasks.filter((t) => t.metadata?.goalId === goal.id)
        if (children.length === 0) continue
        result.push(toGroupTask(goal, children))
        children.forEach((t) => result.push(toGanttTask(t)))
      }
      const orphans = allTasks.filter(
        (t) => !t.metadata?.goalId || !allGoals.some((g) => g.id === t.metadata?.goalId),
      )
      orphans.forEach((t) => result.push(toGanttTask(t)))
    } else {
      allTasks
        .sort((a, b) => (a.dueDate ?? a.createdAt).localeCompare(b.dueDate ?? b.createdAt))
        .forEach((t) => result.push(toGanttTask(t)))
    }

    return result
  }, [entities, relations, groupBy])

  // Render / update Gantt
  useEffect(() => {
    if (!ganttRef.current || ganttTasks.length === 0) return

    try {
      ganttInstanceRef.current = new FrappeGantt(ganttRef.current, ganttTasks, {
        view_mode: viewMode,
        date_format: 'YYYY-MM-DD',
        bar_height: 24,
        bar_corner_radius: 4,
        padding: 16,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        on_click: (task: any) => {
          const entity = entities.find((e) => e.id === task.id)
          if (!entity) return
          if (entity.type === 'project') navigate(`/projects?id=${entity.id}`)
          else if (entity.type === 'goal') navigate(`/goals?id=${entity.id}`)
          else navigate(`/tasks?id=${entity.id}`)
        },
      })
    } catch (err) {
      console.error('Gantt render error:', err)
    }

    return () => {
      if (ganttRef.current) ganttRef.current.innerHTML = ''
      ganttInstanceRef.current = null
    }
  }, [ganttTasks, viewMode, entities, navigate])

  if (ganttTasks.length === 0) {
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
      <style dangerouslySetInnerHTML={{ __html: GANTT_STYLES }} />

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
        <h1 className="text-lg font-semibold flex items-center gap-2">
          <GanttIcon className="h-5 w-5 text-muted-foreground" />
          Timeline
        </h1>
        <div className="flex items-center gap-2">
          <div className="inline-flex items-center rounded-lg bg-muted p-0.5">
            {(['Day', 'Week', 'Month'] as ViewModeKey[]).map((vm) => (
              <button
                key={vm}
                onClick={() => setViewMode(vm)}
                className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                  viewMode === vm
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {vm}
              </button>
            ))}
          </div>
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

      {/* Gantt chart container */}
      <div className="flex-1 overflow-auto">
        <div ref={ganttRef} />
      </div>
    </div>
  )
}
