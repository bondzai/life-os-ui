/**
 * The focus session's exit.
 *
 * A session is "open" everywhere outside the Deep Work page when `sessionId` is set — that is the
 * predicate the sidebar, the tab title and Today all use to show a running timer. So the rule this
 * pins is the one the UI got wrong: **a session that is open must be endable**, and `sessionId`
 * outlives almost every state change, including the ones that look like the session finishing.
 *
 * It got wrong in three places at once, all of which left `sessionId` set while the page rendered
 * a screen with no End button on it. The store is where the invariant is cheapest to state.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { useFocusStore } from './focus-store'

const initial = useFocusStore.getState()

beforeEach(() => {
  useFocusStore.setState(initial, true)
})

describe('an open session', () => {
  it('is open the moment Emperor Time starts, before any timer runs', () => {
    // The trap: `startEmperorTime` opens a session in the `idle` phase. The sidebar calls that
    // running; the page used to render only "Start Focus" for it, with no way out.
    useFocusStore.getState().startEmperorTime(['task-1', 'task-2'])

    const s = useFocusStore.getState()
    expect(s.sessionId).not.toBeNull()
    expect(s.phase).toBe('idle')
    expect(s.isRunning).toBe(false)
  })

  it('survives a finished break, which is not the session finishing', () => {
    useFocusStore.getState().startEmperorTime(['task-1'])
    useFocusStore.getState().setPhase('break')
    useFocusStore.getState().completeBreak()

    const s = useFocusStore.getState()
    expect(s.phase).toBe('idle')
    expect(s.sessionId).not.toBeNull()
    expect(s.emperorEntityIds).toEqual(['task-1'])
  })

  it('survives a work block when breaks do not auto-start', () => {
    useFocusStore.getState().startEmperorTime(['task-1'])
    useFocusStore.getState().updateSettings({ autoStartBreak: false })
    useFocusStore.getState().setPhase('work')
    useFocusStore.getState().completeWorkSession()

    const s = useFocusStore.getState()
    expect(s.phase).toBe('idle')
    expect(s.sessionId).not.toBeNull()
  })

  it('is closed only by endDeepWork, which clears every trace of it', () => {
    useFocusStore.getState().startEmperorTime(['task-1'])
    useFocusStore.getState().setPhase('work')
    useFocusStore.getState().endDeepWork()

    const s = useFocusStore.getState()
    expect(s.sessionId).toBeNull()
    expect(s.emperorEntityIds).toEqual([])
    expect(s.activeEntityId).toBeNull()
    expect(s.isRunning).toBe(false)
    expect(s.phase).toBe('idle')
  })

  it('keeps its ids when the tasks are deleted, so the page must offer a way out', () => {
    // Nothing prunes `emperorEntityIds` — deleting the tasks leaves the session pointing at ids
    // that resolve to nothing, which is the state that used to render as an un-endable planner.
    // The store cannot fix that on its own (an empty entity list also means "still loading"), so
    // this records the shape the page has to handle rather than a behaviour the store can change.
    useFocusStore.getState().startEmperorTime(['deleted-1'])

    const s = useFocusStore.getState()
    expect(s.emperorEntityIds).toEqual(['deleted-1'])
    expect(s.sessionId).not.toBeNull()
  })
})
