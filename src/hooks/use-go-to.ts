/**
 * `g` then a letter, to jump anywhere — `g t` Tasks, `g w` Wealth.
 *
 * The palette already navigates, but it costs a modal, a query and a pick for a destination you
 * knew before you reached for the keyboard. This is the shortcut for the case where you did.
 *
 * Two keys rather than one modifier combo because the single letters are worth more elsewhere and
 * ⌘-anything is mostly taken by the browser. It is the Linear/GitHub convention, so it is a
 * gesture most people already have.
 *
 * The arming window matters: held open forever, a stray `g` turns the next letter you type into
 * a navigation, and you lose your place mid-sentence. Held too briefly, a deliberate `g t` misses.
 */

import { useEffect, useRef } from 'react'
import { useNavigate } from 'react-router'
import { goKeyIndex } from '@/core/config/modules'
import { isTypingTarget } from '@/lib/utils'

/** How long `g` stays armed. Long enough for a deliberate two-key gesture, short enough to forget. */
const ARM_MS = 1200

export function useGoTo() {
  const navigate = useNavigate()
  const armedAt = useRef(0)

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Never while typing, and never as half of a real shortcut.
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTypingTarget(e.target)) return

      const armed = Date.now() - armedAt.current < ARM_MS
      if (!armed) {
        // `g` is also a destination (`g g` → Goals), so arming and dispatching cannot be one
        // branch: the first `g` arms, and only a second one inside the window navigates.
        if (e.key === 'g') armedAt.current = Date.now()
        return
      }

      armedAt.current = 0
      const mod = goKeyIndex[e.key.toLowerCase()]
      if (!mod) return
      e.preventDefault()
      navigate(mod.path)
    }

    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [navigate])
}
