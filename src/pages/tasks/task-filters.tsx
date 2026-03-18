import { Search, X } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import type { Entity, EntityPriority } from '@/core/types'
import { isStory } from './task-helpers'

export interface TaskFilterState {
  search: string
  workspace: 'all' | 'work' | 'personal'
  priorities: Set<EntityPriority>
  type: 'all' | 'task' | 'story'
}

interface TaskFiltersProps {
  filters: TaskFilterState
  onChange: (filters: TaskFilterState) => void
}

export const defaultFilters: TaskFilterState = {
  search: '',
  workspace: 'all',
  priorities: new Set(),
  type: 'all',
}

const priorityColors: Record<EntityPriority, string> = {
  urgent: 'bg-red-500',
  high: 'bg-orange-500',
  medium: 'bg-yellow-500',
  low: 'bg-gray-400',
}

const priorityOptions: EntityPriority[] = ['urgent', 'high', 'medium', 'low']

const typeOptions: Array<{ value: TaskFilterState['type']; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'task', label: 'Task' },
  { value: 'story', label: 'Story' },
]

function isFiltered(filters: TaskFilterState): boolean {
  return (
    filters.search !== '' ||
    filters.priorities.size > 0 ||
    filters.type !== 'all'
  )
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
        active
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
      }`}
    >
      {children}
    </button>
  )
}

export function TaskFilters({ filters, onChange }: TaskFiltersProps) {
  const update = (patch: Partial<TaskFilterState>) =>
    onChange({ ...filters, ...patch })

  const togglePriority = (p: EntityPriority) => {
    const next = new Set(filters.priorities)
    if (next.has(p)) next.delete(p)
    else next.add(p)
    update({ priorities: next })
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Search */}
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={filters.search}
          onChange={(e) => update({ search: e.target.value })}
          placeholder="Search tasks..."
          className="h-8 w-48 pl-8 text-xs"
        />
      </div>

      {/* Divider */}
      <div className="hidden h-5 border-r border-border sm:block" />

      {/* Priority */}
      <div className="flex items-center gap-1">
        {priorityOptions.map((p) => (
          <Chip
            key={p}
            active={filters.priorities.has(p)}
            onClick={() => togglePriority(p)}
          >
            <span className={`inline-block h-1.5 w-1.5 rounded-full ${priorityColors[p]}`} />
            {p.charAt(0).toUpperCase() + p.slice(1)}
          </Chip>
        ))}
      </div>

      {/* Divider */}
      <div className="hidden h-5 border-r border-border sm:block" />

      {/* Type */}
      <div className="flex items-center gap-1">
        {typeOptions.map((opt) => (
          <Chip
            key={opt.value}
            active={filters.type === opt.value}
            onClick={() => update({ type: opt.value })}
          >
            {opt.label}
          </Chip>
        ))}
      </div>

      {/* Clear */}
      {isFiltered(filters) && (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs text-muted-foreground"
          onClick={() => onChange({ ...defaultFilters, workspace: filters.workspace, priorities: new Set() })}
        >
          <X className="mr-1 h-3 w-3" />
          Clear
        </Button>
      )}
    </div>
  )
}

export function applyTaskFilters(tasks: Entity[], filters: TaskFilterState): Entity[] {
  return tasks.filter((task) => {
    // Search
    if (
      filters.search &&
      !task.title.toLowerCase().includes(filters.search.toLowerCase())
    ) {
      return false
    }

    // Workspace
    if (filters.workspace !== 'all' && task.metadata.workspace !== filters.workspace) {
      return false
    }

    // Priority
    if (filters.priorities.size > 0 && !filters.priorities.has(task.priority)) {
      return false
    }

    // Type
    if (filters.type === 'story' && !isStory(task)) return false
    if (filters.type === 'task' && isStory(task)) return false

    return true
  })
}
