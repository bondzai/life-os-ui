import { useState, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router'
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
import { isGoal, isTask } from '@/core/types'

/* ─── Types ─── */

type Zoom = 'day' | 'week' | 'month'
type GroupBy = 'project' | 'goal' | 'none'

interface Row {
  id: string
  label: string
  isGroup: boolean
  indent: number
  startMs: number
  endMs: number
  progress: number
  color: string
  entityType: string
}

/* ─── Constants ─── */

const DAY = 86_400_000
const STATUS_COLOR: Record<string, string> = {
  todo: '#3b82f6',
  'in-progress': '#f59e0b',
  done: '#10b981',
  backlog: '#6b7280',
}
const GROUP_COLOR = '#6366f1'
const ROW_H = 36
const BAR_H = 20
const LEFT_W = 220
const DAY_PX: Record<Zoom, number> = { day: 40, week: 18, month: 5 }

/* ─── Helpers ─── */

function safeMs(s: string | undefined, fb: number): number {
  if (!s) return fb
  const t = new Date(s).getTime()
  return isNaN(t) ? fb : t
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/* ─── Page ─── */

export function GanttPage() {
  const { items: entities } = useEntities()
  const { items: relations } = useRelations()
  const navigate = useNavigate()
  const scrollRef = useRef<HTMLDivElement>(null)

  const [zoom, setZoom] = useState<Zoom>('week')
  const [groupBy, setGroupBy] = useState<GroupBy>('project')
  const [tooltip, setTooltip] = useState<{ x: number; y: number; row: Row } | null>(null)

  const dayWidth = DAY_PX[zoom]

  // Build rows
  const { rows, timeStart, timeEnd } = useMemo(() => {
    const now = Date.now()
    const allTasks = entities.filter((e) => isTask(e) && e.status !== 'archived')
    const allProjects = entities.filter((e) => isGoal(e) && e.status !== 'archived')
    const allGoals = allProjects // isGoal covers both goal and project types
    const result: Row[] = []

    function taskRow(e: Entity, indent: number): Row {
      const s = safeMs(e.createdAt, now)
      let end = e.dueDate ? safeMs(e.dueDate, s + 7 * DAY) : s + 7 * DAY
      if (end <= s) end = s + DAY
      return {
        id: e.id,
        label: e.title,
        isGroup: false,
        indent,
        startMs: s,
        endMs: end,
        progress: e.status === 'done' ? 100 : e.status === 'in-progress' ? 50 : 0,
        color: STATUS_COLOR[e.status] ?? '#3b82f6',
        entityType: e.type,
      }
    }

    function groupRow(e: Entity, children: Entity[]): Row {
      const s = safeMs(e.createdAt, now)
      const ends = children.map((c) => c.dueDate ? safeMs(c.dueDate, s + 14 * DAY) : s + 14 * DAY)
      let end = ends.length > 0 ? Math.max(...ends) : s + 30 * DAY
      if (end <= s) end = s + 7 * DAY
      const done = children.filter((c) => c.status === 'done').length
      return {
        id: e.id,
        label: e.title,
        isGroup: true,
        indent: 0,
        startMs: s,
        endMs: end,
        progress: children.length > 0 ? Math.round((done / children.length) * 100) : 0,
        color: GROUP_COLOR,
        entityType: e.type,
      }
    }

    if (groupBy === 'project') {
      for (const p of allProjects) {
        const kids = allTasks.filter((t) => t.metadata?.projectId === p.id)
        result.push(groupRow(p, kids))
        kids.forEach((t) => result.push(taskRow(t, 1)))
      }
      const orphans = allTasks.filter((t) => !t.metadata?.projectId || !allProjects.some((p) => p.id === t.metadata?.projectId))
      orphans.forEach((t) => result.push(taskRow(t, 0)))
    } else if (groupBy === 'goal') {
      for (const g of allGoals) {
        const kids = allTasks.filter((t) => t.metadata?.goalId === g.id)
        if (kids.length === 0) continue
        result.push(groupRow(g, kids))
        kids.forEach((t) => result.push(taskRow(t, 1)))
      }
      const orphans = allTasks.filter((t) => !t.metadata?.goalId || !allGoals.some((g) => g.id === t.metadata?.goalId))
      orphans.forEach((t) => result.push(taskRow(t, 0)))
    } else {
      allTasks
        .sort((a, b) => (a.dueDate ?? a.createdAt).localeCompare(b.dueDate ?? b.createdAt))
        .forEach((t) => result.push(taskRow(t, 0)))
    }

    // Time range
    let minMs = now
    let maxMs = now + 30 * DAY
    for (const r of result) {
      if (r.startMs < minMs) minMs = r.startMs
      if (r.endMs > maxMs) maxMs = r.endMs
    }
    // Add buffer
    minMs -= 7 * DAY
    maxMs += 7 * DAY

    return { rows: result, timeStart: minMs, timeEnd: maxMs }
  }, [entities, relations, groupBy])

  const totalDays = Math.ceil((timeEnd - timeStart) / DAY)
  const chartWidth = totalDays * dayWidth
  const nowX = ((Date.now() - timeStart) / DAY) * dayWidth

  // Time labels
  const timeLabels = useMemo(() => {
    const labels: { x: number; text: string }[] = []
    const stepDays = zoom === 'day' ? 1 : zoom === 'week' ? 7 : 30
    for (let d = 0; d < totalDays; d += stepDays) {
      const ms = timeStart + d * DAY
      labels.push({ x: d * dayWidth, text: fmtDate(ms) })
    }
    return labels
  }, [timeStart, totalDays, dayWidth, zoom])

  const handleClick = (row: Row) => {
    if (row.entityType === 'project') navigate(`/projects?id=${row.id}`)
    else if (row.entityType === 'goal') navigate(`/goals?id=${row.id}`)
    else navigate(`/tasks?id=${row.id}`)
  }

  if (rows.length === 0) {
    return (
      <div className="p-8">
        <EmptyState icon={GanttIcon} title="No timeline data" description="Create tasks with due dates to see your timeline." />
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
          <div className="inline-flex items-center rounded-lg bg-muted p-0.5">
            {(['day', 'week', 'month'] as Zoom[]).map((z) => (
              <button
                key={z}
                onClick={() => setZoom(z)}
                className={`inline-flex items-center rounded-md px-2.5 py-1 text-xs font-medium transition-colors capitalize ${
                  zoom === z ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {z}
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

      {/* Chart */}
      <div className="flex-1 overflow-auto relative" ref={scrollRef}>
        {/* Tooltip */}
        {tooltip && (
          <div
            className="fixed z-50 bg-popover text-popover-foreground border rounded-lg shadow-lg px-3 py-2 text-xs pointer-events-none"
            style={{ left: tooltip.x + 12, top: tooltip.y - 10 }}
          >
            <p className="font-medium">{tooltip.row.label}</p>
            <p className="text-muted-foreground">{fmtDate(tooltip.row.startMs)} → {fmtDate(tooltip.row.endMs)}</p>
            <p className="text-muted-foreground">Progress: {tooltip.row.progress}%</p>
          </div>
        )}

        <div className="flex" style={{ minWidth: LEFT_W + chartWidth }}>
          {/* Left panel — labels */}
          <div className="sticky left-0 z-10 bg-background border-r shrink-0" style={{ width: LEFT_W }}>
            {/* Header spacer */}
            <div className="h-8 border-b bg-muted/30 px-3 flex items-center">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Name</span>
            </div>
            {rows.map((row) => (
              <div
                key={row.id}
                className="flex items-center border-b border-border/30 cursor-pointer hover:bg-muted/30 transition-colors"
                style={{ height: ROW_H, paddingLeft: 12 + row.indent * 16 }}
                onClick={() => handleClick(row)}
              >
                <span className={`text-xs truncate ${row.isGroup ? 'font-semibold' : ''}`}>
                  {row.label}
                </span>
              </div>
            ))}
          </div>

          {/* Right panel — bars */}
          <div className="relative flex-1" style={{ width: chartWidth }}>
            {/* Time header */}
            <div className="h-8 border-b bg-muted/30 relative">
              {timeLabels.map((l, i) => (
                <span
                  key={i}
                  className="absolute text-[10px] text-muted-foreground whitespace-nowrap"
                  style={{ left: l.x, top: 10 }}
                >
                  {l.text}
                </span>
              ))}
            </div>

            {/* Grid + bars */}
            <svg width={chartWidth} height={rows.length * ROW_H}>
              {/* Grid lines */}
              {timeLabels.map((l, i) => (
                <line key={i} x1={l.x} y1={0} x2={l.x} y2={rows.length * ROW_H} stroke="hsl(var(--border))" strokeWidth={0.5} opacity={0.3} />
              ))}

              {/* Row backgrounds */}
              {rows.map((_, i) => (
                <rect
                  key={i}
                  x={0} y={i * ROW_H} width={chartWidth} height={ROW_H}
                  fill={i % 2 === 0 ? 'transparent' : 'hsl(var(--muted) / 0.15)'}
                />
              ))}

              {/* Today line */}
              {nowX > 0 && nowX < chartWidth && (
                <line x1={nowX} y1={0} x2={nowX} y2={rows.length * ROW_H} stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 3" opacity={0.5} />
              )}

              {/* Bars */}
              {rows.map((row, i) => {
                const x = ((row.startMs - timeStart) / DAY) * dayWidth
                const w = Math.max(((row.endMs - row.startMs) / DAY) * dayWidth, 4)
                const y = i * ROW_H + (ROW_H - BAR_H) / 2

                return (
                  <g
                    key={row.id}
                    className="cursor-pointer"
                    onClick={() => handleClick(row)}
                    onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY, row })}
                    onMouseMove={(e) => setTooltip({ x: e.clientX, y: e.clientY, row })}
                    onMouseLeave={() => setTooltip(null)}
                  >
                    {/* Background bar */}
                    <rect
                      x={x} y={y} width={w} height={BAR_H} rx={4}
                      fill={row.color} opacity={row.isGroup ? 0.5 : 0.8}
                    />
                    {/* Progress fill */}
                    {row.progress > 0 && (
                      <rect
                        x={x} y={y} width={w * (row.progress / 100)} height={BAR_H} rx={4}
                        fill={row.color} opacity={1}
                      />
                    )}
                    {/* Label on bar */}
                    {w > 60 && (
                      <text
                        x={x + 6} y={y + BAR_H / 2 + 1}
                        fill="#fff" fontSize={10} dominantBaseline="middle"
                        className="pointer-events-none"
                      >
                        {row.label.length > Math.floor(w / 6) ? row.label.slice(0, Math.floor(w / 6) - 2) + '...' : row.label}
                      </text>
                    )}
                  </g>
                )
              })}
            </svg>
          </div>
        </div>
      </div>
    </div>
  )
}
