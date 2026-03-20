import { createContext, useContext } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { Target, CheckSquare, Check, Circle, Plus, AlertTriangle } from 'lucide-react'
import type { Entity, EntityStatus, EntityPriority } from '@/core/types'

// ─── Node data types ───

export interface GoalNodeData {
  entity: Entity | null
  title: string
  status: EntityStatus
  priority: EntityPriority
  progress: number
  taskCount: number
  isStale: boolean
  [key: string]: unknown
}

export interface TaskNodeData {
  entity: Entity
  title: string
  status: EntityStatus
  priority: EntityPriority
  subtasksDone: number
  subtasksTotal: number
  isStale: boolean
  [key: string]: unknown
}

export interface SubtaskNodeData {
  title: string
  done: boolean
  priority: EntityPriority
  taskId: string
  subtaskId: string
  [key: string]: unknown
}

// ─── Map actions context ───

export interface MapActions {
  onNodeClick: (entityId: string, type: 'goal' | 'task') => void
  onStatusCycle: (entityId: string) => void
  onAddTask: (goalId: string) => void
  onToggleSubtask: (taskId: string, subtaskId: string) => void
}

export const MapActionsContext = createContext<MapActions>({
  onNodeClick: () => {},
  onStatusCycle: () => {},
  onAddTask: () => {},
  onToggleSubtask: () => {},
})

// ─── Shared ───

const priorityBorder: Record<EntityPriority, string> = {
  urgent: 'border-l-red-500',
  high: 'border-l-orange-500',
  medium: 'border-l-yellow-500',
  low: 'border-l-gray-400',
}

const statusColor: Record<EntityStatus, string> = {
  backlog: 'bg-gray-400',
  todo: 'bg-blue-500',
  'in-progress': 'bg-amber-500',
  done: 'bg-green-500',
  archived: 'bg-gray-600',
}

const statusLabel: Record<EntityStatus, string> = {
  backlog: 'Backlog',
  todo: 'To Do',
  'in-progress': 'In Progress',
  done: 'Done',
  archived: 'Archived',
}

function StatusBadge({ status, onClick }: { status: EntityStatus; onClick?: () => void }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onClick?.() }}
      className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground hover:bg-muted/80 transition-colors cursor-pointer"
      title="Click to cycle status"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${statusColor[status]}`} />
      {statusLabel[status]}
    </button>
  )
}

// ─── GoalNode ───

function GoalNode({ data, id }: NodeProps) {
  const { title, status, priority, progress, taskCount, isStale } = data as unknown as GoalNodeData
  const actions = useContext(MapActionsContext)
  const isVirtual = id === '__uncategorized__'

  return (
    <div
      onClick={() => !isVirtual && actions.onNodeClick(id, 'goal')}
      className={`w-60 rounded-lg border border-l-[3px] ${priorityBorder[priority]} border-border bg-background shadow-sm transition-all hover:shadow-md ${!isVirtual ? 'cursor-pointer' : ''} ${isStale ? 'ring-1 ring-amber-500/40' : ''}`}
    >
      <div className="space-y-2.5 p-3">
        <div className="flex items-start gap-2">
          <Target className="mt-0.5 h-4 w-4 shrink-0 text-primary/70" />
          <span className="text-sm font-semibold leading-tight text-foreground flex-1">
            {title}
          </span>
          {isStale && <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" aria-label="Stale — no updates in 14+ days" />}
        </div>

        <div className="flex items-center justify-between">
          <StatusBadge status={status} onClick={() => !isVirtual && actions.onStatusCycle(id)} />
          <span className="text-[10px] text-muted-foreground/50">{taskCount} tasks</span>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span>Progress</span>
            <span>{progress}%</span>
          </div>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={`h-full rounded-full transition-all ${status === 'done' ? 'bg-green-500' : 'bg-primary'}`}
              style={{ width: `${Math.min(100, Math.max(0, progress))}%` }}
            />
          </div>
        </div>

        {/* Add task button */}
        {!isVirtual && (
          <button
            onClick={(e) => { e.stopPropagation(); actions.onAddTask(id) }}
            className="flex items-center gap-1 text-[10px] text-muted-foreground/40 hover:text-primary transition-colors cursor-pointer w-full"
          >
            <Plus className="h-3 w-3" /> Add task
          </button>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2 !w-2 !rounded-full !border-2 !border-background !bg-muted-foreground"
      />
    </div>
  )
}

// ─── TaskNode ───

function TaskNode({ data, id }: NodeProps) {
  const { title, status, priority, subtasksDone, subtasksTotal, isStale } = data as unknown as TaskNodeData
  const actions = useContext(MapActionsContext)

  return (
    <div
      onClick={() => actions.onNodeClick(id, 'task')}
      className={`w-52 rounded-lg border border-l-[3px] ${priorityBorder[priority]} border-border bg-background shadow-sm transition-all hover:shadow-md cursor-pointer ${isStale ? 'ring-1 ring-amber-500/40' : ''}`}
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2 !w-2 !rounded-full !border-2 !border-background !bg-muted-foreground"
      />

      <div className="space-y-2 p-2.5">
        <div className="flex items-start gap-2">
          <CheckSquare className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className={`text-xs font-medium leading-tight flex-1 ${status === 'done' ? 'line-through text-muted-foreground' : 'text-foreground'}`}>
            {title}
          </span>
          {isStale && <AlertTriangle className="h-3 w-3 shrink-0 text-amber-500" />}
        </div>

        <div className="flex items-center justify-between">
          <StatusBadge status={status} onClick={() => actions.onStatusCycle(id)} />
          {subtasksTotal > 0 && (
            <span className="text-[10px] text-muted-foreground">
              {subtasksDone}/{subtasksTotal}
            </span>
          )}
        </div>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2 !w-2 !rounded-full !border-2 !border-background !bg-muted-foreground"
      />
    </div>
  )
}

// ─── SubtaskNode ───

function SubtaskNode({ data }: NodeProps) {
  const { title, done, priority, taskId, subtaskId } = data as unknown as SubtaskNodeData
  const actions = useContext(MapActionsContext)

  return (
    <div
      onClick={() => actions.onToggleSubtask(taskId, subtaskId)}
      className="w-44 rounded-lg border border-border bg-background shadow-sm transition-all hover:shadow-md cursor-pointer"
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2 !w-2 !rounded-full !border-2 !border-background !bg-muted-foreground"
      />

      <div className="flex items-center gap-2 px-2.5 py-2">
        {done ? (
          <div className="h-4 w-4 rounded-[3px] bg-green-500 flex items-center justify-center shrink-0">
            <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />
          </div>
        ) : (
          <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" />
        )}
        <span className={`flex-1 text-xs leading-tight ${done ? 'text-muted-foreground/50 line-through' : 'text-foreground'}`}>
          {title}
        </span>
        <span className={`h-2 w-2 shrink-0 rounded-full ${
          priority === 'urgent' ? 'bg-red-500' : priority === 'high' ? 'bg-orange-500' : priority === 'medium' ? 'bg-yellow-500' : 'bg-gray-400'
        }`} />
      </div>
    </div>
  )
}

// ─── Export ───

export const nodeTypes = {
  goal: GoalNode,
  task: TaskNode,
  subtask: SubtaskNode,
} as const
