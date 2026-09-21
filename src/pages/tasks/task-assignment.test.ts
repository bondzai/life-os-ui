/**
 * What a task can be assigned to.
 *
 * The interesting cases are all about the single shared field: projects and goals live in the same
 * `metadata.projectId`, so the grouping has to keep them apart in the UI without pretending they
 * are stored apart.
 */

import { describe, expect, it } from 'vitest'
import type { Entity } from '@/core/types'
import { assignmentGroups, assignmentLabel } from './task-assignment'

function entity(id: string, title: string, overrides: Partial<Entity> = {}): Entity {
  return {
    id,
    type: 'project',
    title,
    status: 'todo',
    priority: 'medium',
    tags: [],
    metadata: {},
    ownerId: 'me',
    visibility: 'private',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  }
}

describe('assignmentGroups', () => {
  it('keeps projects and goals in separate groups', () => {
    const groups = assignmentGroups(
      [entity('p1', 'Shorts channel')],
      [entity('g1', 'Ship v3', { type: 'goal' })],
    )
    expect(groups.projects.map((p) => p.id)).toEqual(['p1'])
    expect(groups.goals.map((g) => g.id)).toEqual(['g1'])
  })

  it('drops archived entries from the picker', () => {
    // Assigning fresh work to a dropped project is almost always a misclick.
    const groups = assignmentGroups(
      [entity('p1', 'Live'), entity('p2', 'Dropped', { status: 'archived' })],
      [],
    )
    expect(groups.projects.map((p) => p.title)).toEqual(['Live'])
  })

  it('sorts by title so the list does not shuffle as entities are edited', () => {
    const groups = assignmentGroups(
      [entity('p1', 'Nostr filter engine'), entity('p2', 'Client: Acme'), entity('p3', 'Shorts')],
      [],
    )
    expect(groups.projects.map((p) => p.title)).toEqual([
      'Client: Acme',
      'Nostr filter engine',
      'Shorts',
    ])
  })

  it('handles having neither', () => {
    const groups = assignmentGroups([], [])
    expect(groups.projects).toEqual([])
    expect(groups.goals).toEqual([])
  })
})

describe('assignmentLabel', () => {
  const groups = assignmentGroups(
    [entity('p1', 'Shorts channel')],
    [entity('g1', 'Ship v3', { type: 'goal' })],
  )

  it('names whichever kind the id points at', () => {
    expect(assignmentLabel('p1', groups)).toBe('Shorts channel')
    expect(assignmentLabel('g1', groups)).toBe('Ship v3')
  })

  it('says nothing is assigned when nothing is', () => {
    expect(assignmentLabel(undefined, groups)).toBe('No project or goal')
  })

  it('does not pass a dangling id off as unassigned', () => {
    // The API hard-deletes with no cascade, so a task can outlive its project. "Unassigned" and
    // "pointing at something deleted" are different facts and the second one wants fixing.
    expect(assignmentLabel('gone', groups)).toBe('Unknown (deleted)')
  })
})
