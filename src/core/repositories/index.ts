import { EntityRepository } from './entity-repository'
import { TrackerRepository } from './tracker-repository'
import { ScheduleRepository } from './schedule-repository'
import { RelationRepository } from './relation-repository'
import { ApiEntityRepository } from './api-entity-repository'
import { ApiTrackerRepository } from './api-tracker-repository'
import { ApiScheduleRepository } from './api-schedule-repository'
import { ApiRelationRepository } from './api-relation-repository'

// Runtime toggle: localStorage overrides env var
// 'demo' mode uses local storage with mock data
const storedMode = localStorage.getItem('lyra:data-mode')

/**
 * Whether this session talks to the real backend.
 *
 * Exported because every feature has to agree on the answer: a session in demo mode showing live
 * balances — or an API session showing invented ones — is worse than either mode on its own.
 */
export const USE_API = storedMode !== null
  ? storedMode === 'api'
  : import.meta.env.VITE_USE_API === 'true'

export const entityRepository = USE_API ? new ApiEntityRepository() : new EntityRepository()
export const trackerRepository = USE_API ? new ApiTrackerRepository() : new TrackerRepository()
export const scheduleRepository = USE_API ? new ApiScheduleRepository() : new ScheduleRepository()
export const relationRepository = USE_API ? new ApiRelationRepository() : new RelationRepository()

export type { IRepository } from './base-repository'
