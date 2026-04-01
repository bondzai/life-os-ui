import { describe, it, expect } from 'vitest'
import { isGoal, isTask, type Entity } from './entity'

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
