import { describe, it, expect } from 'vitest'
import {
  getRecurrence, nextDueDate, isStory, getSubtasks, getSubtaskProgress,
  subtaskStatus, subtaskDone, isOverdue, formatShortDate,
  demoteToSubtask, promoteToTask, type Subtask,
} from './task-helpers'
import type { Entity } from '@/core/types'

const makeEntity = (overrides: Partial<Entity> = {}): Entity => ({
  id: 'e1', type: 'task', title: 'Test Task', status: 'todo',
  priority: 'medium', tags: [], metadata: {}, ownerId: 'u1', visibility: 'private',
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  ...overrides,
})

describe('getRecurrence', () => {
  it('returns none for empty metadata', () => expect(getRecurrence({})).toBe('none'))
  it('returns daily', () => expect(getRecurrence({ recurring: 'daily' })).toBe('daily'))
  it('returns none for invalid', () => expect(getRecurrence({ recurring: 'invalid' })).toBe('none'))
})

describe('nextDueDate', () => {
  it('returns a string for daily', () => {
    const next = nextDueDate('2099-06-15', 'daily')
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
  it('returns a string for weekly', () => {
    const next = nextDueDate('2099-06-15', 'weekly')
    expect(next).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('isStory', () => {
  it('returns false for no subtasks', () => expect(isStory(makeEntity())).toBe(false))
  it('returns true with subtasks', () =>
    expect(isStory(makeEntity({ metadata: { subtasks: [{ id: '1', title: 'sub', done: false }] } }))).toBe(true))
  it('returns true with isStory flag', () =>
    expect(isStory(makeEntity({ metadata: { isStory: true } }))).toBe(true))
})

describe('getSubtasks', () => {
  it('returns empty for no subtasks', () => expect(getSubtasks({})).toEqual([]))
  it('returns subtasks array', () => {
    const subs = [{ id: '1', title: 'sub', done: false }]
    expect(getSubtasks({ subtasks: subs })).toEqual(subs)
  })
})

describe('getSubtaskProgress', () => {
  it('returns null for no subtasks', () => expect(getSubtaskProgress({})).toBeNull())
  it('calculates progress', () => {
    const meta = { subtasks: [
      { id: '1', title: 'a', done: true },
      { id: '2', title: 'b', done: false },
    ]}
    const progress = getSubtaskProgress(meta)
    expect(progress?.done).toBe(1)
    expect(progress?.total).toBe(2)
    expect(progress?.pct).toBe(50)
  })
})

describe('subtaskStatus / subtaskDone', () => {
  it('returns todo for undone subtask', () => {
    const s: Subtask = { id: '1', title: 'test', done: false }
    expect(subtaskStatus(s)).toBe('todo')
    expect(subtaskDone(s)).toBe(false)
  })
  it('returns done for done subtask', () => {
    const s: Subtask = { id: '1', title: 'test', done: true }
    expect(subtaskDone(s)).toBe(true)
  })
  it('respects status field over done', () => {
    const s: Subtask = { id: '1', title: 'test', done: false, status: 'in-progress' }
    expect(subtaskStatus(s)).toBe('in-progress')
    expect(subtaskDone(s)).toBe(false)
  })
})

describe('isOverdue', () => {
  it('returns false for no due date', () => expect(isOverdue(undefined, 'todo')).toBe(false))
  it('returns false for done', () => expect(isOverdue('2020-01-01', 'done')).toBe(false))
  it('returns true for past due date', () => expect(isOverdue('2020-01-01', 'todo')).toBe(true))
  it('returns false for future due date', () => expect(isOverdue('2099-01-01', 'todo')).toBe(false))
})

describe('formatShortDate', () => {
  it('formats date string', () => {
    const result = formatShortDate('2026-04-01')
    expect(result).toBeTruthy()
    expect(typeof result).toBe('string')
  })
})

describe('demoteToSubtask', () => {
  it('converts task to subtask entry', () => {
    const task = makeEntity({ title: 'Child', priority: 'high', status: 'in-progress' })
    const parent = makeEntity({ id: 'p1', title: 'Parent', metadata: {} })
    const { parentMetadata } = demoteToSubtask(task, parent)
    const subs = parentMetadata.subtasks as Subtask[]
    expect(subs).toHaveLength(1)
    expect(subs[0].title).toBe('Child')
    expect(subs[0].priority).toBe('high')
    expect(parentMetadata.isStory).toBe(true)
  })

  it('appends to existing subtasks', () => {
    const task = makeEntity({ title: 'New' })
    const parent = makeEntity({ metadata: { subtasks: [{ id: 'x', title: 'Existing', done: false }] } })
    const { parentMetadata } = demoteToSubtask(task, parent)
    expect((parentMetadata.subtasks as Subtask[]).length).toBe(2)
  })
})

describe('promoteToTask', () => {
  it('converts subtask to task fields', () => {
    const sub: Subtask = { id: 's1', title: 'Promoted', done: false, priority: 'high' }
    const parent = makeEntity({
      metadata: {
        subtasks: [sub, { id: 's2', title: 'Stay', done: false }],
        goalId: 'g1',
      },
    })
    const { taskFields, parentMetadata } = promoteToTask(sub, parent)
    expect(taskFields.title).toBe('Promoted')
    expect(taskFields.priority).toBe('high')
    expect(taskFields.metadata.goalId).toBe('g1')
    expect((parentMetadata.subtasks as Subtask[]).length).toBe(1)
    expect((parentMetadata.subtasks as Subtask[])[0].title).toBe('Stay')
  })
})
