// Import tools to trigger registration via side effects
import './break-down'
import './analyze-risk'
import './coaching'
import './weekly-summary'
import './suggest-priorities'
import './plan-session'
import './parse-capture'
import './web-search'
import './wealth-portfolio-review'
import './wealth-tier-drift'
import './wealth-lp-health'
import './wealth-concentration'

// Re-export registry API
export { getTool, getAllTools, getToolsForScope, registerTool } from './registry'
export type { AITool, ToolParams, ChatMessage } from './registry'
