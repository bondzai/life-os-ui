declare module 'frappe-gantt' {
  interface GanttTask {
    id: string
    name: string
    start: string
    end: string
    progress: number
    dependencies: string
    custom_class?: string
  }

  interface GanttOptions {
    view_mode?: string
    date_format?: string
    bar_height?: number
    bar_corner_radius?: number
    padding?: number
    on_click?: (task: GanttTask) => void
    on_date_change?: (task: GanttTask, start: Date, end: Date) => void
    on_progress_change?: (task: GanttTask, progress: number) => void
    on_view_change?: (mode: string) => void
  }

  class Gantt {
    constructor(element: HTMLElement | string, tasks: GanttTask[], options?: GanttOptions)
    change_view_mode(mode: string): void
    refresh(tasks: GanttTask[]): void
  }

  export default Gantt
}
