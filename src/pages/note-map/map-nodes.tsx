import { createContext, useContext } from 'react'
import { Handle, Position } from '@xyflow/react'
import type { NodeProps } from '@xyflow/react'
import { NotebookPen, Pin } from 'lucide-react'
import type { Entity } from '@/core/types'

// ─── Node data types ───

export interface NoteNodeData {
  entity: Entity
  title: string
  tagCount: number
  isPinned: boolean
  [key: string]: unknown
}

export interface TagNodeData {
  label: string
  count: number
  [key: string]: unknown
}

// ─── Map actions context ───

export interface NoteMapActions {
  onNodeClick: (noteId: string) => void
  onTagClick: (tag: string) => void
}

export const MapActionsContext = createContext<NoteMapActions>({
  onNodeClick: () => {},
  onTagClick: () => {},
})

// ─── Color palette for tags ───

const TAG_COLORS = [
  'hsl(217 91% 60% / 0.15)',
  'hsl(142 71% 45% / 0.15)',
  'hsl(262 83% 58% / 0.15)',
  'hsl(25 95% 53% / 0.15)',
  'hsl(330 81% 60% / 0.15)',
  'hsl(180 60% 45% / 0.15)',
  'hsl(45 93% 47% / 0.15)',
  'hsl(0 84% 60% / 0.15)',
]

const TAG_BORDER_COLORS = [
  'hsl(217 91% 60% / 0.4)',
  'hsl(142 71% 45% / 0.4)',
  'hsl(262 83% 58% / 0.4)',
  'hsl(25 95% 53% / 0.4)',
  'hsl(330 81% 60% / 0.4)',
  'hsl(180 60% 45% / 0.4)',
  'hsl(45 93% 47% / 0.4)',
  'hsl(0 84% 60% / 0.4)',
]

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0
  }
  return Math.abs(hash)
}

// ─── NoteNode ───

function NoteNode({ data, id }: NodeProps) {
  const { title, tagCount, isPinned } = data as unknown as NoteNodeData
  const actions = useContext(MapActionsContext)

  return (
    <div
      onClick={() => actions.onNodeClick(id)}
      className="w-[200px] rounded-lg border border-border bg-background shadow-sm transition-all hover:shadow-md cursor-pointer"
    >
      <Handle
        type="target"
        position={Position.Top}
        className="!h-2 !w-2 !rounded-full !border-2 !border-background !bg-muted-foreground"
      />

      <div className="space-y-1.5 p-3">
        <div className="flex items-start gap-2">
          <NotebookPen className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary/70" />
          <span className="text-xs font-medium leading-tight text-foreground flex-1 line-clamp-2">
            {title}
          </span>
          {isPinned && <Pin className="h-3 w-3 shrink-0 text-amber-500" />}
        </div>

        {tagCount > 0 && (
          <div className="flex justify-end">
            <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
              {tagCount} tag{tagCount !== 1 ? 's' : ''}
            </span>
          </div>
        )}
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        className="!h-2 !w-2 !rounded-full !border-2 !border-background !bg-muted-foreground"
      />
      <Handle
        type="source"
        position={Position.Left}
        id="left"
        className="!h-2 !w-2 !rounded-full !border-2 !border-background !bg-muted-foreground"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="right"
        className="!h-2 !w-2 !rounded-full !border-2 !border-background !bg-muted-foreground"
      />
    </div>
  )
}

// ─── TagNode ───

function TagNode({ data, id }: NodeProps) {
  const { label, count } = data as unknown as TagNodeData
  const actions = useContext(MapActionsContext)
  const colorIndex = hashString(label) % TAG_COLORS.length

  return (
    <div
      onClick={() => actions.onTagClick(label)}
      className="flex h-20 w-20 cursor-pointer items-center justify-center rounded-full border transition-all hover:scale-105"
      style={{
        backgroundColor: TAG_COLORS[colorIndex],
        borderColor: TAG_BORDER_COLORS[colorIndex],
      }}
    >
      <Handle
        type="target"
        position={Position.Top}
        id={`${id}-top`}
        className="!h-2 !w-2 !rounded-full !border-2 !border-background !bg-muted-foreground"
      />

      <div className="flex flex-col items-center gap-0.5 px-1">
        <span className="text-[11px] font-medium text-foreground leading-tight text-center line-clamp-2">
          {label}
        </span>
        <span className="text-[9px] text-muted-foreground">{count}</span>
      </div>

      <Handle
        type="source"
        position={Position.Bottom}
        id={`${id}-bottom`}
        className="!h-2 !w-2 !rounded-full !border-2 !border-background !bg-muted-foreground"
      />
      <Handle
        type="target"
        position={Position.Left}
        id={`${id}-left`}
        className="!h-2 !w-2 !rounded-full !border-2 !border-background !bg-muted-foreground"
      />
      <Handle
        type="target"
        position={Position.Right}
        id={`${id}-right`}
        className="!h-2 !w-2 !rounded-full !border-2 !border-background !bg-muted-foreground"
      />
    </div>
  )
}

// ─── Export ───

export const nodeTypes = {
  note: NoteNode,
  tag: TagNode,
} as const
