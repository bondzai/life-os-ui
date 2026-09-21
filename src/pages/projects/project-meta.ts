/**
 * The shape of a project's `metadata`, and the words the UI uses for its status.
 *
 * `metadata` is `Record<string, unknown>` everywhere in this codebase — flexible on purpose, and
 * untyped as a result. This narrows it for projects in one place, so a page never reaches into the
 * blob and hopes.
 *
 * Split out of `projects.tsx` so it can be tested directly: a file exporting both components and
 * helpers loses fast refresh.
 */

import type { Entity, EntityStatus } from '@/core/types'

/**
 * Project vocabulary over the entity status enum.
 *
 * The API validates `status` against `backlog | todo | in-progress | done | archived` and rejects
 * anything else, so a project's states are those five wearing different labels rather than a
 * second status field in metadata. That keeps sorting, filtering and every other surface working
 * on one vocabulary underneath.
 */
const STATUS_LABELS: Record<EntityStatus, string> = {
  backlog: 'Idea',
  todo: 'Planned',
  'in-progress': 'Active',
  done: 'Done',
  archived: 'Dropped',
}

/** Every status a project can be in, in the order they happen. */
export const PROJECT_STATUSES: EntityStatus[] = [
  'backlog',
  'todo',
  'in-progress',
  'done',
  'archived',
]

export function projectStatusLabel(status: EntityStatus): string {
  return STATUS_LABELS[status] ?? status
}

/** The optional half of a project. Every field is absent on something like a Shorts channel. */
export interface ProjectFacts {
  /** Set on freelance work, unset on your own. */
  client?: string
  /** Repo, channel, doc — whatever this project's home is. */
  repoUrl?: string
  /** Free-form, lowercase by convention but not enforced. */
  stack: string[]
}

/**
 * Read a project's facts out of its metadata blob.
 *
 * Tolerant by design: metadata is written by several versions of this app and by the AI layer, so
 * a field of the wrong type is treated as absent rather than crashing a render. An empty string is
 * absent too — the inline editor writes `undefined` when cleared, but older rows may hold `""`.
 */
export function projectOf(entity: Pick<Entity, 'metadata'>): ProjectFacts {
  const metadata = entity.metadata ?? {}
  return {
    client: text(metadata.client),
    repoUrl: text(metadata.repoUrl),
    stack: Array.isArray(metadata.stack)
      ? metadata.stack.filter((item): item is string => typeof item === 'string' && item !== '')
      : [],
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}
