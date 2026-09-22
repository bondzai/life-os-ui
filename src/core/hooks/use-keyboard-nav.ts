import { useCallback, useEffect, useState } from 'react'
import { isTypingTarget } from '@/lib/utils'

/**
 * J/K keyboard navigation for entity lists.
 * Returns the focused index and a ref callback for the container.
 *
 * - `J` = move down, `K` = move up
 * - `Enter` = select current item
 * - Skips when an input/textarea/select is focused or a modifier key is held
 */
export function useKeyboardNav<T>(
  items: T[],
  onSelect: (item: T) => void,
) {
  const [focusedIndex, setFocusedIndex] = useState(-1)

  // Reset when items change
  useEffect(() => {
    setFocusedIndex(-1)
  }, [items])

  // Scroll focused item into view
  useEffect(() => {
    if (focusedIndex < 0) return
    const el = document.querySelector(`[data-nav-index="${focusedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusedIndex])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Skip when typing in inputs or modals
      if (isTypingTarget(document.activeElement)) return
      if (e.metaKey || e.ctrlKey || e.altKey) return

      // Skip if a dialog/sheet is open (check for radix overlay)
      if (document.querySelector('[data-state="open"][role="dialog"]')) return

      if (e.key === 'j' || e.key === 'J') {
        e.preventDefault()
        setFocusedIndex((prev) => {
          const next = prev + 1
          return next < items.length ? next : prev
        })
      } else if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        setFocusedIndex((prev) => {
          const next = prev - 1
          return next >= 0 ? next : prev
        })
      } else if (e.key === 'Enter' && focusedIndex >= 0 && focusedIndex < items.length) {
        e.preventDefault()
        onSelect(items[focusedIndex])
      } else if (e.key === 'Escape') {
        setFocusedIndex(-1)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [items, focusedIndex, onSelect])

  const reset = useCallback(() => setFocusedIndex(-1), [])

  return { focusedIndex, setFocusedIndex, reset }
}
