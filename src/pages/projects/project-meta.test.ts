/**
 * The project metadata reader.
 *
 * Worth pinning because `metadata` is `Record<string, unknown>` by design and is written by
 * several versions of this app and by the AI layer. The reader's job is to be boring about that:
 * a field of the wrong type is absent, not a crash and not a lie.
 */

import { describe, expect, it } from 'vitest'
import { PROJECT_STATUSES, projectOf, projectStatusLabel } from './project-meta'

describe('projectOf', () => {
  it('reads the optional half when it is there', () => {
    const facts = projectOf({
      metadata: {
        client: 'Acme',
        repoUrl: 'https://github.com/x/y',
        stack: ['rust', 'react'],
      },
    })
    expect(facts.client).toBe('Acme')
    expect(facts.repoUrl).toBe('https://github.com/x/y')
    expect(facts.stack).toEqual(['rust', 'react'])
  })

  it('treats a Shorts-style project with no extras as empty, not broken', () => {
    const facts = projectOf({ metadata: {} })
    expect(facts.client).toBeUndefined()
    expect(facts.repoUrl).toBeUndefined()
    expect(facts.stack).toEqual([])
  })

  it('treats a blank string as absent', () => {
    // The inline editor writes undefined when a field is cleared, but rows written by older code
    // hold "" — and an empty "Client:" line on a card is worse than no line.
    const facts = projectOf({ metadata: { client: '   ', repoUrl: '' } })
    expect(facts.client).toBeUndefined()
    expect(facts.repoUrl).toBeUndefined()
  })

  it('survives metadata of the wrong shape', () => {
    const facts = projectOf({
      metadata: { client: 42, repoUrl: null, stack: 'rust, react' },
    })
    expect(facts.client).toBeUndefined()
    expect(facts.repoUrl).toBeUndefined()
    // A string is not a stack. Dropped rather than split on commas and guessed at.
    expect(facts.stack).toEqual([])
  })

  it('keeps only the strings out of a mixed stack array', () => {
    const facts = projectOf({ metadata: { stack: ['rust', 7, null, '', 'react'] } })
    expect(facts.stack).toEqual(['rust', 'react'])
  })
})

describe('projectStatusLabel', () => {
  it('speaks about projects while storing entity statuses', () => {
    // The API validates status against the entity enum and rejects anything else, so these five
    // are the same values wearing project words.
    expect(projectStatusLabel('backlog')).toBe('Idea')
    expect(projectStatusLabel('in-progress')).toBe('Active')
    expect(projectStatusLabel('archived')).toBe('Dropped')
  })

  it('covers every status the filter offers', () => {
    for (const status of PROJECT_STATUSES) {
      expect(projectStatusLabel(status)).not.toBe(status)
    }
  })
})
