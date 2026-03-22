import { useState, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router'
import { GanttChart } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EmptyState } from '@/core/components/empty-state'
import { useEntities, useRelations } from '@/core/hooks'
import type { Entity, EntityStatus, EntityPriority } from '@/core/types'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ZoomLevel = 'day' | 'week' | 'month'
type GroupBy = 'project' | 'goal' | 'none'

interface GanttRow {
  id: string
  label: string
  type: 'project' | 'goal' | 'task'
  indent: number
  startDate: string
  endDate: string
  status: EntityStatus
  priority: EntityPriority
  progress: number
  dependencies: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysBetween(a: string, b: string): number {
  const msPerDay = 86_400_000
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / msPerDay)
}

function dateToX(date: string, startDate: string, dayWidth: number): number {
  return daysBetween(startDate, date) * dayWidth
}

function addDays(date: string, days: number): string {
  const d = new Date(date)
  d.setDate(d.getDate() + days)
  return d.toISOString().slice(0, 10)
}

function startOfDay(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10)
}

function getWeekNumber(d: Date): number {
  const target = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const dayNr = (target.getUTCDay() + 6) % 7
  target.setUTCDate(target.getUTCDate() - dayNr + 3)
  const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4))
  return 1 + Math.round((target.getTime() - firstThursday.getTime()) / 604_800_000)
}

const STATUS_COLORS: Record<EntityStatus, string> = {
  todo: '#3b82f6',
  'in-progress': '#f59e0b',
  done: '#10b981',
  backlog: '#9ca3af',
  archived: '#6b7280',
}

const ZOOM_CONFIG: Record<ZoomLevel, { dayWidth: number }> = {
  day: { dayWidth: 40 },
  week: { dayWidth: 20 },
  month: { dayWidth: 6 },
}

const ROW_HEIGHT = 36
const BAR_HEIGHT = 20
const HEADER_BAR_HEIGHT = 24
const LEFT_PANEL_WIDTH = 220
const HEADER_HEIGHT = 48

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function GanttPage() {
  const navigate = useNavigate()
  const { items: allEntities, isLoading } = useEntities()
  const { items: allRelations } = useRelations()

  const [zoom, setZoom] = useState<ZoomLevel>('week')
  const [groupBy, setGroupBy] = useState<GroupBy>('project')
  const [tooltip, setTooltip] = useState<{
    row: GanttRow
    x: number
    y: number
  } | null>(null)

  const timelineRef = useRef<HTMLDivElement>(null)

  // Build entities maps
  const { projects, goals, tasks } = useMemo(() => {
    const projects: Entity[] = []
    const goals: Entity[] = []
    const tasks: Entity[] = []
    for (const e of allEntities) {
      if (e.type === 'project') projects.push(e)
      else if (e.type === 'goal') goals.push(e)
      else if (e.type === 'task') tasks.push(e)
    }
    return { projects, goals, tasks }
  }, [allEntities])

  // Blocking relations
  const blockingRelations = useMemo(
    () => allRelations.filter((r) => r.type === 'blocks'),
    [allRelations],
  )

  // Build GanttRows
  const rows = useMemo((): GanttRow[] => {
    const result: GanttRow[] = []

    const taskDeps = (taskId: string): string[] =>
      blockingRelations.filter((r) => r.toId === taskId).map((r) => r.fromId)

    const toRow = (e: Entity, type: GanttRow['type'], indent: number): GanttRow => ({
      id: e.id,
      label: e.title,
      type,
      indent,
      startDate: startOfDay(e.createdAt),
      endDate: e.dueDate ? startOfDay(e.dueDate) : startOfDay(e.updatedAt),
      status: e.status,
      priority: e.priority,
      progress:
        e.status === 'done'
          ? 100
          : e.status === 'in-progress'
            ? typeof e.metadata.progress === 'number'
              ? (e.metadata.progress as number)
              : 50
            : 0,
      dependencies: taskDeps(e.id),
    })

    if (groupBy === 'project') {
      // Group tasks by project
      const projectTaskMap = new Map<string, Entity[]>()
      const ungrouped: Entity[] = []
      for (const t of tasks) {
        const pid = t.metadata.projectId as string | undefined
        if (pid) {
          const list = projectTaskMap.get(pid) ?? []
          list.push(t)
          projectTaskMap.set(pid, list)
        } else {
          ungrouped.push(t)
        }
      }

      for (const p of projects) {
        result.push(toRow(p, 'project', 0))
        const pTasks = projectTaskMap.get(p.id) ?? []
        pTasks.sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        )
        for (const t of pTasks) {
          result.push(toRow(t, 'task', 1))
        }
      }

      // Ungrouped tasks with dates
      for (const t of ungrouped) {
        if (t.dueDate || t.createdAt) {
          result.push(toRow(t, 'task', 0))
        }
      }
    } else if (groupBy === 'goal') {
      const goalTaskMap = new Map<string, Entity[]>()
      const ungrouped: Entity[] = []
      for (const t of tasks) {
        const gid = t.metadata.goalId as string | undefined
        if (gid) {
          const list = goalTaskMap.get(gid) ?? []
          list.push(t)
          goalTaskMap.set(gid, list)
        } else {
          ungrouped.push(t)
        }
      }

      for (const g of goals) {
        if (g.parentId) continue // skip sub-goals as top-level
        result.push(toRow(g, 'goal', 0))
        const gTasks = goalTaskMap.get(g.id) ?? []
        gTasks.sort(
          (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
        )
        for (const t of gTasks) {
          result.push(toRow(t, 'task', 1))
        }
      }

      for (const t of ungrouped) {
        if (t.dueDate || t.createdAt) {
          result.push(toRow(t, 'task', 0))
        }
      }
    } else {
      // Flat list
      const allTasks = [...tasks].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
      )
      for (const t of allTasks) {
        if (t.dueDate || t.createdAt) {
          result.push(toRow(t, 'task', 0))
        }
      }
    }

    return result
  }, [tasks, projects, goals, blockingRelations, groupBy])

  // Time range
  const { timelineStart, totalDays } = useMemo(() => {
    if (rows.length === 0)
      return { timelineStart: startOfDay(new Date().toISOString()), timelineEnd: addDays(new Date().toISOString(), 30), totalDays: 30 }

    let earliest = rows[0].startDate
    let latest = rows[0].endDate
    for (const r of rows) {
      if (r.startDate < earliest) earliest = r.startDate
      if (r.endDate > latest) latest = r.endDate
    }
    // Add buffer
    earliest = addDays(earliest, -7)
    latest = addDays(latest, 14)

    const today = startOfDay(new Date().toISOString())
    if (today > latest) latest = addDays(today, 14)
    if (today < earliest) earliest = addDays(today, -7)

    return {
      timelineStart: earliest,
      timelineEnd: latest,
      totalDays: Math.max(daysBetween(earliest, latest), 30),
    }
  }, [rows])

  const { dayWidth } = ZOOM_CONFIG[zoom]
  const timelineWidth = totalDays * dayWidth

  // Build row position map for dependency arrows
  const rowIndexMap = useMemo(() => {
    const map = new Map<string, number>()
    rows.forEach((r, i) => map.set(r.id, i))
    return map
  }, [rows])

  // Grid lines & labels
  const gridLines = useMemo(() => {
    const lines: { x: number; label: string; isMajor: boolean }[] = []
    const start = new Date(timelineStart)

    if (zoom === 'day') {
      for (let d = 0; d <= totalDays; d++) {
        const current = new Date(start)
        current.setDate(current.getDate() + d)
        const x = d * dayWidth
        const isMajor = current.getDay() === 1 // Monday
        const label = current.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        lines.push({ x, label: isMajor || d % 2 === 0 ? label : '', isMajor })
      }
    } else if (zoom === 'week') {
      for (let d = 0; d <= totalDays; d++) {
        const current = new Date(start)
        current.setDate(current.getDate() + d)
        if (current.getDay() === 1 || d === 0) {
          const x = d * dayWidth
          const wk = getWeekNumber(current)
          const label = `${current.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
          lines.push({ x, label: `W${wk} ${label}`, isMajor: current.getDate() <= 7 })
        }
      }
    } else {
      // month
      for (let d = 0; d <= totalDays; d++) {
        const current = new Date(start)
        current.setDate(current.getDate() + d)
        if (current.getDate() === 1 || d === 0) {
          const x = d * dayWidth
          const label = current.toLocaleDateString('en-US', { month: 'short', year: '2-digit' })
          lines.push({ x, label, isMajor: true })
        }
      }
    }

    return lines
  }, [timelineStart, totalDays, dayWidth, zoom])

  // Today x position
  const todayX = useMemo(
    () => dateToX(startOfDay(new Date().toISOString()), timelineStart, dayWidth),
    [timelineStart, dayWidth],
  )

  // Navigation
  const handleRowClick = useCallback(
    (row: GanttRow) => {
      if (row.type === 'task') navigate(`/tasks?id=${row.id}`)
      else if (row.type === 'goal') navigate(`/goals?id=${row.id}`)
      else if (row.type === 'project') navigate(`/projects?id=${row.id}`)
    },
    [navigate],
  )

  // Tooltip handlers
  const handleBarMouseEnter = useCallback(
    (row: GanttRow, e: React.MouseEvent) => {
      const rect = timelineRef.current?.getBoundingClientRect()
      if (!rect) return
      setTooltip({
        row,
        x: e.clientX - rect.left,
        y: e.clientY - rect.top,
      })
    },
    [],
  )

  const handleBarMouseLeave = useCallback(() => {
    setTooltip(null)
  }, [])

  if (isLoading) {
    return <div className="p-4 text-muted-foreground">Loading...</div>
  }

  if (rows.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Gantt Chart</h1>
        </div>
        <EmptyState
          icon={GanttChart}
          title="No timeline data"
          description="Create projects, goals, or tasks with dates to see them on the timeline."
        />
      </div>
    )
  }

  const contentHeight = rows.length * ROW_HEIGHT

  return (
    <div className="space-y-4">
      {/* Header controls */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <h1 className="text-lg font-semibold">Gantt Chart</h1>
        <div className="flex items-center gap-2">
          {/* Zoom controls */}
          <div className="flex items-center rounded-md border">
            {(['day', 'week', 'month'] as ZoomLevel[]).map((level) => (
              <Button
                key={level}
                size="sm"
                variant={zoom === level ? 'default' : 'ghost'}
                className="h-7 px-3 text-xs capitalize rounded-none first:rounded-l-md last:rounded-r-md"
                onClick={() => setZoom(level)}
              >
                {level}
              </Button>
            ))}
          </div>

          {/* Group by */}
          <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
            <SelectTrigger className="w-[140px] h-8">
              <SelectValue placeholder="Group by" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="project">Project</SelectItem>
              <SelectItem value="goal">Goal</SelectItem>
              <SelectItem value="none">None</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Gantt chart */}
      <div className="border rounded-lg overflow-hidden bg-card">
        <div className="flex">
          {/* Left panel */}
          <div
            className="shrink-0 border-r bg-muted/30"
            style={{ width: LEFT_PANEL_WIDTH }}
          >
            {/* Left header */}
            <div
              className="border-b px-3 flex items-center text-xs font-medium text-muted-foreground"
              style={{ height: HEADER_HEIGHT }}
            >
              Name
            </div>
            {/* Left rows */}
            <div className="overflow-y-auto" style={{ maxHeight: `calc(100vh - 200px)` }}>
              {rows.map((row) => (
                <div
                  key={row.id}
                  className="flex items-center border-b border-border/20 px-3 cursor-pointer hover:bg-accent/50 transition-colors"
                  style={{ height: ROW_HEIGHT, paddingLeft: 12 + row.indent * 16 }}
                  onClick={() => handleRowClick(row)}
                >
                  <span
                    className={`text-xs truncate ${
                      row.type !== 'task'
                        ? 'font-semibold text-foreground'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {row.label}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Right panel: timeline */}
          <div
            ref={timelineRef}
            className="flex-1 overflow-x-auto overflow-y-auto relative"
            style={{ maxHeight: `calc(100vh - 200px)` }}
          >
            {/* Timeline header */}
            <div
              className="sticky top-0 z-10 bg-muted/60 backdrop-blur border-b"
              style={{ height: HEADER_HEIGHT, width: timelineWidth }}
            >
              <svg width={timelineWidth} height={HEADER_HEIGHT}>
                {gridLines.map((line, i) =>
                  line.label ? (
                    <text
                      key={i}
                      x={line.x + 4}
                      y={32}
                      className={`text-[10px] ${
                        line.isMajor
                          ? 'fill-foreground font-medium'
                          : 'fill-muted-foreground'
                      }`}
                    >
                      {line.label}
                    </text>
                  ) : null,
                )}
              </svg>
            </div>

            {/* Timeline body */}
            <div style={{ width: timelineWidth, height: contentHeight }} className="relative">
              <svg width={timelineWidth} height={contentHeight} className="absolute inset-0">
                {/* Grid lines */}
                {gridLines.map((line, i) => (
                  <line
                    key={`gl-${i}`}
                    x1={line.x}
                    y1={0}
                    x2={line.x}
                    y2={contentHeight}
                    className={
                      line.isMajor
                        ? 'stroke-border/40'
                        : 'stroke-border/20'
                    }
                    strokeWidth={1}
                  />
                ))}

                {/* Row backgrounds (alternating) */}
                {rows.map((_, i) =>
                  i % 2 === 1 ? (
                    <rect
                      key={`rb-${i}`}
                      x={0}
                      y={i * ROW_HEIGHT}
                      width={timelineWidth}
                      height={ROW_HEIGHT}
                      className="fill-muted/20"
                    />
                  ) : null,
                )}

                {/* Today line */}
                {todayX > 0 && todayX < timelineWidth && (
                  <line
                    x1={todayX}
                    y1={0}
                    x2={todayX}
                    y2={contentHeight}
                    stroke="#ef4444"
                    strokeWidth={1.5}
                    strokeDasharray="6 4"
                  />
                )}

                {/* Dependency arrows */}
                {rows.map((row) =>
                  row.dependencies.map((depId) => {
                    const fromIdx = rowIndexMap.get(depId)
                    const toIdx = rowIndexMap.get(row.id)
                    if (fromIdx === undefined || toIdx === undefined) return null
                    const fromRow = rows[fromIdx]

                    const fromX = dateToX(fromRow.endDate, timelineStart, dayWidth)
                    const fromY = fromIdx * ROW_HEIGHT + ROW_HEIGHT / 2
                    const toX = dateToX(row.startDate, timelineStart, dayWidth)
                    const toY = toIdx * ROW_HEIGHT + ROW_HEIGHT / 2

                    // Draw an L-shaped or curved path
                    const midX = fromX + 10
                    const path = `M ${fromX} ${fromY} L ${midX} ${fromY} L ${midX} ${toY} L ${toX} ${toY}`

                    return (
                      <g key={`dep-${depId}-${row.id}`}>
                        <path
                          d={path}
                          fill="none"
                          className="stroke-muted-foreground/50"
                          strokeWidth={1.5}
                        />
                        {/* Arrow head */}
                        <polygon
                          points={`${toX},${toY} ${toX - 5},${toY - 3} ${toX - 5},${toY + 3}`}
                          className="fill-muted-foreground/50"
                        />
                      </g>
                    )
                  }),
                )}

                {/* Bars */}
                {rows.map((row, i) => {
                  const x = dateToX(row.startDate, timelineStart, dayWidth)
                  const barWidth = Math.max(
                    dateToX(row.endDate, timelineStart, dayWidth) - x,
                    dayWidth * 0.5,
                  )
                  const isHeader = row.type !== 'task'
                  const barH = isHeader ? HEADER_BAR_HEIGHT : BAR_HEIGHT
                  const y = i * ROW_HEIGHT + (ROW_HEIGHT - barH) / 2
                  const color = STATUS_COLORS[row.status]

                  return (
                    <g
                      key={`bar-${row.id}`}
                      className="cursor-pointer"
                      onClick={() => handleRowClick(row)}
                      onMouseEnter={(e) => handleBarMouseEnter(row, e)}
                      onMouseLeave={handleBarMouseLeave}
                    >
                      {/* Background bar */}
                      <rect
                        x={x}
                        y={y}
                        width={barWidth}
                        height={barH}
                        rx={4}
                        fill={color}
                        opacity={isHeader ? 0.35 : 0.25}
                      />
                      {/* Progress fill */}
                      {row.progress > 0 && (
                        <rect
                          x={x}
                          y={y}
                          width={barWidth * (row.progress / 100)}
                          height={barH}
                          rx={4}
                          fill={color}
                          opacity={isHeader ? 0.6 : 0.85}
                        />
                      )}
                      {/* Border */}
                      <rect
                        x={x}
                        y={y}
                        width={barWidth}
                        height={barH}
                        rx={4}
                        fill="none"
                        stroke={color}
                        strokeWidth={1}
                        opacity={0.6}
                      />
                      {/* Label on bar if wide enough */}
                      {barWidth > 60 && (
                        <text
                          x={x + 6}
                          y={y + barH / 2 + 4}
                          className="fill-foreground text-[10px] pointer-events-none"
                        >
                          {row.label.length > barWidth / 7
                            ? row.label.slice(0, Math.floor(barWidth / 7)) + '...'
                            : row.label}
                        </text>
                      )}
                    </g>
                  )
                })}

                {/* Today label */}
                {todayX > 0 && todayX < timelineWidth && (
                  <text x={todayX + 4} y={14} className="fill-red-500 text-[10px] font-medium">
                    today
                  </text>
                )}
              </svg>

              {/* Tooltip */}
              {tooltip && (
                <div
                  className="absolute z-20 pointer-events-none bg-popover border rounded-md shadow-md px-3 py-2 text-xs space-y-1"
                  style={{
                    left: Math.min(tooltip.x + 12, timelineWidth - 200),
                    top: tooltip.y - 60,
                  }}
                >
                  <div className="font-medium text-foreground">{tooltip.row.label}</div>
                  <div className="text-muted-foreground capitalize">
                    Status:{' '}
                    <span
                      className="font-medium"
                      style={{ color: STATUS_COLORS[tooltip.row.status] }}
                    >
                      {tooltip.row.status}
                    </span>
                  </div>
                  <div className="text-muted-foreground capitalize">
                    Priority: {tooltip.row.priority}
                  </div>
                  <div className="text-muted-foreground">
                    {new Date(tooltip.row.startDate).toLocaleDateString()} &mdash;{' '}
                    {new Date(tooltip.row.endDate).toLocaleDateString()}
                  </div>
                  {tooltip.row.progress > 0 && (
                    <div className="text-muted-foreground">
                      Progress: {tooltip.row.progress}%
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
