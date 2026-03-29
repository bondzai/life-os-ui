import { useCallback, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  type ReactFlowInstance,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Maximize2, X, ExternalLink, CheckSquare, Target } from 'lucide-react'
import { useNavigate } from 'react-router'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import type { Entity, EntityStatus } from '@/core/types'
import { isTask } from '@/core/types'
import { useGoalGraph } from './goal-map/use-goal-graph'
import { nodeTypes, MapActionsContext, type MapActions } from './goal-map/map-nodes'
import { StatusBadge } from '@/core/components/status-badge'
import { PriorityBadge } from '@/core/components/priority-badge'

const STATUS_CYCLE: EntityStatus[] = ['todo', 'in-progress', 'done']

export function GoalMapPage() {
  const { nodes, edges, goals, tasks } = useGoalGraph()
  const { update, create } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)
  const navigate = useNavigate()
  const rfRef = useRef<ReactFlowInstance | null>(null)
  const [selected, setSelected] = useState<{ entity: Entity; type: 'goal' | 'task' } | null>(null)

  const handleFitView = useCallback(() => {
    rfRef.current?.fitView({ padding: 0.2 })
  }, [])

  const allEntities = useMemo(() => [...goals, ...tasks], [goals, tasks])

  const actions: MapActions = useMemo(() => ({
    onNodeClick: (entityId, type) => {
      const entity = allEntities.find((e) => e.id === entityId)
      if (entity) setSelected({ entity, type })
    },
    onStatusCycle: (entityId) => {
      const entity = allEntities.find((e) => e.id === entityId)
      if (!entity) return
      const idx = STATUS_CYCLE.indexOf(entity.status)
      const next = STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length]
      update.mutate({ id: entityId, updates: { status: next } })
      toast.success(`Status → ${next}`)
    },
    onAddTask: (goalId) => {
      if (!currentUser) return
      const goal = goals.find((g) => g.id === goalId)
      const newTask: Entity = {
        id: crypto.randomUUID(),
        type: 'task',
        title: `New task for ${goal?.title ?? 'goal'}`,
        status: 'todo',
        priority: 'medium',
        tags: [],
        metadata: { goalId },
        ownerId: currentUser.id,
        visibility: 'private',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
      create.mutate(newTask)
      toast.success('Task created')
    },
    onToggleSubtask: (taskId, subtaskId) => {
      const task = tasks.find((t) => t.id === taskId)
      if (!task) return
      const subtasks = (task.metadata?.subtasks as Array<{ id: string; done: boolean }>) ?? []
      const updated = subtasks.map((s) =>
        s.id === subtaskId ? { ...s, done: !s.done } : s,
      )
      update.mutate({ id: taskId, updates: { metadata: { ...task.metadata, subtasks: updated } } })
    },
  }), [allEntities, goals, tasks, update, create, currentUser])

  // Detail panel entity — get fresh version from allEntities
  const detailEntity = selected ? allEntities.find((e) => e.id === selected.entity.id) ?? selected.entity : null

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-3">
          <h1 className="text-lg font-semibold">Goal Map</h1>
          <span className="text-xs text-muted-foreground/50">{nodes.length} nodes</span>
        </div>
        <Button variant="outline" size="sm" onClick={handleFitView}>
          <Maximize2 className="mr-1.5 h-3.5 w-3.5" />
          Fit View
        </Button>
      </div>

      <div className="relative flex-1">
        <MapActionsContext.Provider value={actions}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            proOptions={{ hideAttribution: true }}
            onInit={(instance) => { rfRef.current = instance }}
            onPaneClick={() => setSelected(null)}
            defaultEdgeOptions={{
              type: 'smoothstep',
              style: { stroke: 'hsl(var(--border))' },
            }}
          >
            <Background variant={BackgroundVariant.Lines} gap={20} size={1} color="hsl(var(--border) / 0.4)" />
            <Controls
              showInteractive={false}
              className="!rounded-lg !border !border-border !bg-background !shadow-sm [&>button]:!border-border [&>button]:!bg-background [&>button]:!fill-foreground hover:[&>button]:!bg-muted"
            />
            <MiniMap
              nodeColor="hsl(var(--muted))"
              maskColor="hsl(var(--background) / 0.7)"
              className="!rounded-lg !border !border-border !bg-background/80 !shadow-sm"
            />
          </ReactFlow>
        </MapActionsContext.Provider>

        {/* Detail side panel */}
        {selected && detailEntity && (
          <div className="absolute right-0 top-0 h-full w-80 border-l bg-background shadow-lg overflow-y-auto animate-in slide-in-from-right-2 duration-200">
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                  {selected.type === 'goal' ? <Target className="h-4 w-4" /> : <CheckSquare className="h-4 w-4" />}
                  {selected.type === 'goal' ? 'Goal' : 'Task'}
                </div>
                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setSelected(null)}>
                  <X className="h-4 w-4" />
                </Button>
              </div>

              <h2 className="text-base font-semibold leading-snug">{detailEntity.title}</h2>

              {detailEntity.description && (
                <p className="text-sm text-muted-foreground leading-relaxed">{detailEntity.description}</p>
              )}

              <div className="flex items-center gap-2">
                <StatusBadge status={detailEntity.status} />
                <PriorityBadge priority={detailEntity.priority} />
              </div>

              {detailEntity.tags.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {detailEntity.tags.map((tag) => (
                    <span key={tag} className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                      {tag}
                    </span>
                  ))}
                </div>
              )}

              {detailEntity.dueDate && (
                <div className="text-xs text-muted-foreground">
                  Due: {new Date(detailEntity.dueDate).toLocaleDateString()}
                </div>
              )}

              {/* Subtasks for tasks */}
              {isTask(detailEntity) && (() => {
                const subs = (detailEntity.metadata?.subtasks as Array<{ id: string; title: string; done: boolean }>) ?? []
                if (subs.length === 0) return null
                return (
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      Subtasks ({subs.filter((s) => s.done).length}/{subs.length})
                    </span>
                    {subs.map((sub) => (
                      <button
                        key={sub.id}
                        onClick={() => actions.onToggleSubtask(detailEntity.id, sub.id)}
                        className="flex items-center gap-2 w-full text-left text-xs py-1 hover:bg-muted/50 rounded px-1.5 cursor-pointer"
                      >
                        <span className={`h-3 w-3 rounded-sm border ${sub.done ? 'bg-green-500 border-green-500' : 'border-border'}`} />
                        <span className={sub.done ? 'line-through text-muted-foreground/50' : ''}>{sub.title}</span>
                      </button>
                    ))}
                  </div>
                )
              })()}

              {/* Child tasks for goals */}
              {selected.type === 'goal' && (() => {
                const childTasks = tasks.filter((t) => t.metadata?.goalId === detailEntity.id)
                if (childTasks.length === 0) return null
                return (
                  <div className="space-y-1.5">
                    <span className="text-xs font-medium text-muted-foreground">
                      Tasks ({childTasks.filter((t) => t.status === 'done').length}/{childTasks.length})
                    </span>
                    {childTasks.map((task) => (
                      <button
                        key={task.id}
                        onClick={() => setSelected({ entity: task, type: 'task' })}
                        className="flex items-center gap-2 w-full text-left text-xs py-1 hover:bg-muted/50 rounded px-1.5 cursor-pointer"
                      >
                        <CheckSquare className="h-3 w-3 shrink-0 text-muted-foreground" />
                        <span className={`flex-1 ${task.status === 'done' ? 'line-through text-muted-foreground/50' : ''}`}>
                          {task.title}
                        </span>
                      </button>
                    ))}
                  </div>
                )
              })()}

              <div className="pt-2 border-t">
                <Button
                  variant="outline"
                  size="sm"
                  className="w-full text-xs"
                  onClick={() => navigate(selected.type === 'goal' ? '/goals' : '/tasks')}
                >
                  <ExternalLink className="mr-1.5 h-3 w-3" />
                  Open in {selected.type === 'goal' ? 'Goals' : 'Tasks'}
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
