import { describe, it, expect } from 'vitest'
import { isDueTask, isGoal, isTask, type Entity } from './entity'

const makeEntity = (type: string): Entity => ({
  id: '1', type: type as Entity['type'], title: 'Test', status: 'todo',
  priority: 'medium', tags: [], metadata: {}, ownerId: '', visibility: 'private',
  createdAt: '', updatedAt: '',
})

describe('isGoal', () => {
  it('matches goal type', () => expect(isGoal(makeEntity('goal'))).toBe(true))
  it('matches project type (legacy)', () => expect(isGoal(makeEntity('project'))).toBe(true))
  it('rejects task type', () => expect(isGoal(makeEntity('task'))).toBe(false))
  it('rejects habit type', () => expect(isGoal(makeEntity('habit'))).toBe(false))
})

describe('isTask', () => {
  it('matches task type', () => expect(isTask(makeEntity('task'))).toBe(true))
  it('matches chore type (legacy)', () => expect(isTask(makeEntity('chore'))).toBe(true))
  it('rejects goal type', () => expect(isTask(makeEntity('goal'))).toBe(false))
  it('rejects habit type', () => expect(isTask(makeEntity('habit'))).toBe(false))
})

// ── isDueTask ───────────────────────────────────────────────────────────────────────────────────
//
// The rule the sidebar badge and the Tasks page share. Built from the rows that made the badge say
// 12 while the page showed none of them: an import on 2026-03-14 left statuses the app has never
// used — `completed`, `active`, `paused` — and a rule that only excluded the closed statuses it knew
// about counted every one as due.

const TODAY = '2026-09-22'

/**
 * `status` is typed as a plain string on purpose: the rows this guards against carry values outside
 * `EntityStatus` entirely, and a helper that only accepted valid statuses could not express them.
 */
function task(over: Omit<Partial<Entity>, 'status'> & { status: string }): Entity {
  return {
    id: 'x',
    type: 'task',
    title: 't',
    priority: 'medium',
    tags: [],
    metadata: {},
    ownerId: 'user-jb',
    visibility: 'private',
    createdAt: '2026-03-14',
    updatedAt: '2026-03-14',
    dueDate: '2026-09-01',
    ...over,
    status: over.status as Entity['status'],
  } as Entity
}

describe('isDueTask', () => {
  it('counts an open task that is due or overdue', () => {
    expect(isDueTask(task({ status: 'todo' }), TODAY)).toBe(true)
    expect(isDueTask(task({ status: 'in-progress', dueDate: TODAY }), TODAY)).toBe(true)
  })

  it('does not count a status it does not recognise — the bug behind the 12', () => {
    // A leftover `completed` is finished work; counting it as due is the badge promising work the
    // page cannot show.
    for (const legacy of ['completed', 'active', 'paused']) {
      expect(isDueTask(task({ status: legacy }), TODAY), legacy).toBe(false)
    }
  })

  it('does not count closed or parked work', () => {
    for (const status of ['done', 'archived', 'backlog']) {
      expect(isDueTask(task({ status }), TODAY), status).toBe(false)
    }
  })

  it('does not count work that is not due yet, or has no date', () => {
    expect(isDueTask(task({ status: 'todo', dueDate: '2026-09-23' }), TODAY)).toBe(false)
    expect(isDueTask(task({ status: 'todo', dueDate: undefined }), TODAY)).toBe(false)
  })

  it('compares on the day, so a stored timestamp counts as the day it falls on', () => {
    // Late on the 22nd in a stored timestamp is still due on the 22nd — the string compare on the
    // whole value would have said the timestamp was "after" the date.
    expect(isDueTask(task({ status: 'todo', dueDate: '2026-09-22T18:00:00.000Z' }), TODAY)).toBe(true)
  })

  it('counts chores the way the Tasks page lists them', () => {
    expect(isDueTask(task({ status: 'todo', type: 'chore' }), TODAY)).toBe(true)
    expect(isDueTask(task({ status: 'todo', type: 'note' }), TODAY)).toBe(false)
  })
})
