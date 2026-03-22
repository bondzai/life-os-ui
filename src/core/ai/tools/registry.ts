import type { EntityType } from '@/core/types'

export interface ToolParams {
  entityId?: string
  entities: import('@/core/types').Entity[]
  trackers: import('@/core/types/tracker').Tracker[]
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AITool {
  id: string
  name: string
  description: string
  scope: EntityType[] | 'global'
  buildPrompt: (params: ToolParams) => ChatMessage[]
}

/* ─── Registry ─── */

const tools = new Map<string, AITool>()

export function registerTool(tool: AITool) {
  tools.set(tool.id, tool)
}

export function getTool(id: string): AITool | undefined {
  return tools.get(id)
}

export function getAllTools(): AITool[] {
  return Array.from(tools.values())
}

export function getToolsForScope(entityType: EntityType): AITool[] {
  return getAllTools().filter(
    (t) => t.scope === 'global' || t.scope.includes(entityType),
  )
}
