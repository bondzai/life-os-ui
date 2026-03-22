import { useMemo, useState, useCallback } from 'react'
import { useEntities, useTrackers } from '@/core/hooks'
import {
  getAllWidgets,
  getWidgetComponent,
  type DashboardWidget,
  type WidgetContext,
} from './widgets'
import type { ComponentType } from 'react'
import type { WidgetProps } from './widgets'

export interface WidgetSelection {
  widget: DashboardWidget
  component: ComponentType<WidgetProps>
  relevance: number | null
}

const STORAGE_KEY = 'lyra:dashboard-layout'

function loadPrefs(): { pinned: string[]; hidden: string[] } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        pinned: Array.isArray(parsed.pinned) ? parsed.pinned : [],
        hidden: Array.isArray(parsed.hidden) ? parsed.hidden : [],
      }
    }
  } catch {
    // ignore
  }
  return { pinned: [], hidden: [] }
}

function savePrefs(pinned: string[], hidden: string[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ pinned, hidden }))
}

export function useDashboardLayout() {
  const { items: entities } = useEntities()
  const { items: trackers } = useTrackers()

  const [prefs, setPrefs] = useState(loadPrefs)
  const [shuffleSeed, setShuffleSeed] = useState(0)

  const allWidgets = useMemo(() => getAllWidgets(), [])

  const today = useMemo(() => new Date().toISOString().split('T')[0], [])
  const now = useMemo(() => Date.now(), [])

  const ctx: WidgetContext = useMemo(
    () => ({ entities, trackers, today, now }),
    [entities, trackers, today, now],
  )

  const selectedWidgets = useMemo(() => {
    // Compute relevance for all widgets
    const scored: Array<{
      widget: DashboardWidget
      relevance: number | null
      isPinned: boolean
    }> = []

    for (const widget of allWidgets) {
      if (prefs.hidden.includes(widget.id)) continue

      const isPinned = prefs.pinned.includes(widget.id)
      let relevance: number | null = null
      try {
        relevance = widget.relevance(ctx)
      } catch {
        // widget relevance function failed, skip
      }

      // Include if pinned (regardless of relevance) or if relevance is non-null
      if (isPinned || relevance !== null) {
        scored.push({ widget, relevance, isPinned })
      }
    }

    // Sort: pinned first, then by relevance desc
    scored.sort((a, b) => {
      if (a.isPinned && !b.isPinned) return -1
      if (!a.isPinned && b.isPinned) return 1
      return (b.relevance ?? 0) - (a.relevance ?? 0)
    })

    // Take top 6
    const top = scored.slice(0, 6)

    // Map to WidgetSelection
    const result: WidgetSelection[] = []
    for (const item of top) {
      const component = getWidgetComponent(item.widget.id)
      if (component) {
        result.push({
          widget: item.widget,
          component,
          relevance: item.relevance,
        })
      }
    }

    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allWidgets, prefs, ctx, shuffleSeed])

  const pinWidget = useCallback(
    (id: string) => {
      setPrefs((prev) => {
        const pinned = prev.pinned.includes(id)
          ? prev.pinned
          : [...prev.pinned, id]
        const hidden = prev.hidden.filter((h) => h !== id)
        savePrefs(pinned, hidden)
        return { pinned, hidden }
      })
    },
    [],
  )

  const unpinWidget = useCallback(
    (id: string) => {
      setPrefs((prev) => {
        const pinned = prev.pinned.filter((p) => p !== id)
        savePrefs(pinned, prev.hidden)
        return { ...prev, pinned }
      })
    },
    [],
  )

  const hideWidget = useCallback(
    (id: string) => {
      setPrefs((prev) => {
        const hidden = prev.hidden.includes(id)
          ? prev.hidden
          : [...prev.hidden, id]
        const pinned = prev.pinned.filter((p) => p !== id)
        savePrefs(pinned, hidden)
        return { pinned, hidden }
      })
    },
    [],
  )

  const unhideWidget = useCallback(
    (id: string) => {
      setPrefs((prev) => {
        const hidden = prev.hidden.filter((h) => h !== id)
        savePrefs(prev.pinned, hidden)
        return { ...prev, hidden }
      })
    },
    [],
  )

  const shuffle = useCallback(() => {
    setShuffleSeed((s) => s + 1)
  }, [])

  return {
    selectedWidgets,
    allWidgets,
    pinWidget,
    unpinWidget,
    hideWidget,
    unhideWidget,
    shuffle,
    pinnedIds: prefs.pinned,
    hiddenIds: prefs.hidden,
  }
}
