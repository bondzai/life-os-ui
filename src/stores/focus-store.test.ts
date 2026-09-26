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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

/**
 * The timer against the clock.
 *
 * `secondsLeft` used to be the timer itself, and it was persisted, so time only passed while a
 * tick was firing. Close the tab mid-block, open it the next morning, and the countdown picked up
 * exactly where it left off — the night had not happened. The timer now runs on a deadline, which
 * is the same instant whether the tab was shut, the laptop asleep, or the interval throttled.
 */
describe('the timer against the clock', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-23T09:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  /** Put a session in localStorage as a previous visit would have left it, then come back. */
  async function reopenWith(state: Record<string, unknown>) {
    localStorage.setItem(
      'lyra:focus',
      JSON.stringify({ state: { ...useFocusStore.getState(), ...state }, version: 0 }),
    )
    await useFocusStore.persist.rehydrate()
    return useFocusStore.getState()
  }

  it('counts a tick off the clock, not off the last rendered number', () => {
    // A backgrounded tab fires this far less than once a second. Decrementing lost the
    // difference, so the timer ran slow exactly when nobody was watching it.
    useFocusStore.getState().startEmperorTime(['task-1'])
    useFocusStore.getState().setPhase('work')
    const full = useFocusStore.getState().secondsLeft

    vi.advanceTimersByTime(10_000)
    expect(useFocusStore.getState().tick()).toBe(false)

    expect(useFocusStore.getState().secondsLeft).toBe(full - 10)
  })

  it('pauses on what is actually left, not on what was last drawn', () => {
    useFocusStore.getState().startEmperorTime(['task-1'])
    useFocusStore.getState().setPhase('work')
    const full = useFocusStore.getState().secondsLeft

    vi.advanceTimersByTime(90_000)
    useFocusStore.getState().pauseTimer()

    const s = useFocusStore.getState()
    expect(s.secondsLeft).toBe(full - 90)
    expect(s.isRunning).toBe(false)
    expect(s.runningUntil).toBeNull()
  })

  it('holds its ground while paused, however long you are gone', () => {
    useFocusStore.getState().startEmperorTime(['task-1'])
    useFocusStore.getState().setPhase('work')
    useFocusStore.getState().pauseTimer()
    const left = useFocusStore.getState().secondsLeft

    vi.advanceTimersByTime(3 * 60 * 60 * 1000)

    expect(useFocusStore.getState().secondsLeft).toBe(left)
  })

  it('charges a closed tab for the time it was closed', async () => {
    const s = await reopenWith({
      sessionId: 'sess-1',
      emperorEntityIds: ['task-1'],
      phase: 'work',
      isRunning: true,
      secondsLeft: 25 * 60,
      runningUntil: Date.now() + 25 * 60 * 1000 - 10 * 60 * 1000, // 10 minutes already gone
    })

    expect(s.secondsLeft).toBe(15 * 60)
    expect(s.isRunning).toBe(true)
  })

  it('comes back idle from a block that ended overnight, crediting nothing', async () => {
    // Deliberately not counted as a completed session: the tracker row would claim focus minutes
    // for someone who shut the laptop and went to bed, and that number is the point of the
    // feature. The session stays open, so it is still there to end or restart.
    const s = await reopenWith({
      sessionId: 'sess-1',
      emperorEntityIds: ['task-1'],
      phase: 'work',
      isRunning: true,
      completedSessions: 2,
      secondsLeft: 18 * 60,
      runningUntil: Date.now() - 8 * 60 * 60 * 1000,
    })

    expect(s.phase).toBe('idle')
    expect(s.isRunning).toBe(false)
    expect(s.runningUntil).toBeNull()
    expect(s.completedSessions).toBe(2)
    expect(s.sessionId).toBe('sess-1')
  })

  it('gives a session saved before deadlines existed one, rather than stranding it', async () => {
    const s = await reopenWith({
      sessionId: 'sess-1',
      emperorEntityIds: ['task-1'],
      phase: 'work',
      isRunning: true,
      secondsLeft: 300,
      runningUntil: undefined,
    })

    expect(s.secondsLeft).toBe(300)
    expect(s.runningUntil).toBe(Date.now() + 300_000)
  })
})
