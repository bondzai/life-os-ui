// Import tools to trigger registration via side effects
import './suggest-focus'
import './break-down'
import './analyze-risk'
import './coaching'
import './weekly-summary'

// Re-export registry API
export { getTool, getAllTools, getToolsForScope, registerTool } from './registry'
export type { AITool, ToolParams, ChatMessage } from './registry'
