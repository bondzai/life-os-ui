import { EntityRepository } from './entity-repository'
import { TrackerRepository } from './tracker-repository'
import { ScheduleRepository } from './schedule-repository'
import { RelationRepository } from './relation-repository'

export const entityRepository = new EntityRepository()
export const trackerRepository = new TrackerRepository()
export const scheduleRepository = new ScheduleRepository()
export const relationRepository = new RelationRepository()

export type { IRepository } from './base-repository'
export { LocalRepository } from './local-repository'
