// Import all widgets to trigger registration
import './streak-tracker'
import './overdue-tasks'
import './project-velocity'
import './budget-meter'
import './sleep-trend'
import './goal-progress'
import './focus-hours'
import './energy-pattern'
import './stale-projects'
import './upcoming-events'
import './decision-review'
import './weekly-velocity'

// Re-export registry
export {
  getAllWidgets,
  getWidget,
  getWidgetComponent,
  registerWidget,
  type DashboardWidget,
  type WidgetContext,
  type WidgetProps,
} from './registry'
