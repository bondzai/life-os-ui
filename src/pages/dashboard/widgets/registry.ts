import type { ComponentType } from 'react'
import type { Entity, Tracker } from '@/core/types'

export interface WidgetContext {
  entities: Entity[]
  trackers: Tracker[]
  today: string
  now: number
}

export interface WidgetProps {
  entities: Entity[]
  trackers: Tracker[]
}

export interface DashboardWidget {
  id: string
  name: string
  /** Return null to hide, 1-3 for relevance/severity */
  relevance: (ctx: WidgetContext) => number | null
}

const widgets = new Map<string, DashboardWidget>()
const components = new Map<string, ComponentType<WidgetProps>>()

export function registerWidget(
  widget: DashboardWidget,
  component: ComponentType<WidgetProps>,
) {
  widgets.set(widget.id, widget)
  components.set(widget.id, component)
}

export function getWidget(id: string) {
  return widgets.get(id)
}

export function getWidgetComponent(id: string) {
  return components.get(id)
}

export function getAllWidgets() {
  return Array.from(widgets.values())
}
