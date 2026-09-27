/**
 * The focus timer's remaining seconds, told by the clock rather than by the last tick.
 *
 * The Deep Work page owns the timer: its interval is what advances `secondsLeft` in the store.
 * Everywhere else — the sidebar badge, the tab title, the Continue button on Today — was reading
 * that cached number, so the moment you navigated away from Deep Work the countdown froze at
 * whatever it last said and sat there, wrong, for as long as you were gone.
 *
 * So these read the deadline instead. They deliberately do not write to the store: there is one
 * timer, it belongs to the page, and a second writer would be two clocks to keep in step.
 *
 * The wall clock is an external source that changes without React being told, which is exactly
 * what `useSyncExternalStore` is for. The snapshot is whole seconds, so it is stable between
 * renders inside the same second even though `Date.now()` underneath it is not.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { useFocusStore } from '@/stores/focus-store'

/** Twice a second, so the displayed second turns over promptly rather than up to 1s late. */
const POLL_MS = 500

export function useFocusCountdown(): number {
  const secondsLeft = useFocusStore((s) => s.secondsLeft)
  const runningUntil = useFocusStore((s) => s.runningUntil)

  const subscribe = useCallback(
    (onChange: () => void) => {
      // Paused: nothing to poll. The stored number is already the truth.
      if (runningUntil === null) return () => {}
      const id = setInterval(onChange, POLL_MS)
      return () => clearInterval(id)
    },
    [runningUntil],
  )

  const snapshot = useCallback(
    () =>
      runningUntil === null
        ? secondsLeft
        : Math.max(0, Math.ceil((runningUntil - Date.now()) / 1000)),
    [runningUntil, secondsLeft],
  )

  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
