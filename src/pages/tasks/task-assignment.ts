/**
 * What a task can belong to.
 *
 * # One field, two kinds of parent
 *
 * A task's owner is stored in `metadata.projectId`, and it has always been able to hold a *goal's*
 * id — the picker offered goals and the field kept its older name. Now that projects exist again,
 * both go in the same field rather than each getting its own.
 *
 * That is deliberate, and it is the reason there is no migration here. Ids are unique across
 * types, so a stored id is unambiguous without knowing which kind it points at: the Projects page
 * matches it against projects, `use-velocity` matches it against whichever entity it was asked
 * about, and a task pointing at a goal simply never matches a project. Splitting it into two
 * fields would mean rewriting every existing row to guess which of the two an old id meant.
 *
 * The cost is honest and small: a task belongs to one thing, not to a project *and* a goal.
 */

import type { Entity } from '@/core/types'

/** The things a task can be assigned to, grouped for the picker. */
export interface AssignmentGroups {
  projects: Entity[]
  goals: Entity[]
}

/**
 * Split the assignable entities into groups, dropping the ones nobody wants to pick.
 *
 * Archived is excluded because assigning work to a dropped project is almost always a misclick;
 * a task already pointing at one keeps its link, it just cannot be chosen again from here.
 * Sorted by title so the list does not reorder itself as entities are edited.
 */
export function assignmentGroups(projects: Entity[], goals: Entity[]): AssignmentGroups {
  return {
    projects: assignable(projects),
    goals: assignable(goals),
  }
}

function assignable(entities: Entity[]): Entity[] {
  return entities
    .filter((entity) => entity.status !== 'archived')
    .sort((a, b) => a.title.localeCompare(b.title))
}

/**
 * What the trigger shows for a stored id.
 *
 * An id that matches nothing still renders as something — a project can be deleted while a task
 * still points at it, and the API hard-deletes with no cascade. "Unknown" is the honest word for
 * that; showing an empty box would read as "not assigned", which is a different fact.
 */
export function assignmentLabel(
  id: string | undefined,
  groups: AssignmentGroups,
  fallback = 'No project or goal',
): string {
  if (!id) return fallback
  const found = [...groups.projects, ...groups.goals].find((entity) => entity.id === id)
  return found?.title ?? 'Unknown (deleted)'
}
