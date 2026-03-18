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
const storedMode = localStorage.getItem('life-os:data-mode')
const useApi = storedMode !== null
  ? storedMode === 'api'
  : import.meta.env.VITE_USE_API === 'true'

export const entityRepository = useApi ? new ApiEntityRepository() : new EntityRepository()
export const trackerRepository = useApi ? new ApiTrackerRepository() : new TrackerRepository()
export const scheduleRepository = useApi ? new ApiScheduleRepository() : new ScheduleRepository()
export const relationRepository = useApi ? new ApiRelationRepository() : new RelationRepository()

export type { IRepository } from './base-repository'
