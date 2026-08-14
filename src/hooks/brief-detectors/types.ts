import type { Entity } from '@/core/types'
import type { Tracker } from '@/core/types/tracker'
import type { WealthBrief } from '@/core/ai/context/wealth-context'

/* ─── Insight — the universal signal format ─── */

export type InsightType = 'warning' | 'risk' | 'streak' | 'achievement' | 'suggestion' | 'info'

export type InsightCategory =
  | 'tasks'
  | 'habits'
  | 'projects'
  | 'health'
  | 'wealth'
  | 'goals'
  | 'energy'
  | 'decisions'
  | 'focus'

export type InsightSeverity = 1 | 2 | 3 // 3=critical, 2=important, 1=info

export interface Insight {
  id: string
  type: InsightType
  category: InsightCategory
  severity: InsightSeverity
  title: string
  detail?: string
  actionLabel?: string
  actionPath?: string
  /** Raw data for future AI context injection */
  data: Record<string, unknown>
}

/* ─── Detector context — all data a detector might need ─── */

export interface DetectorContext {
  entities: Entity[]
  trackers: Tracker[]
  today: string // YYYY-MM-DD
  now: number // Date.now()
  /**
   * Wealth snapshot, when the portfolio has loaded.
   *
   * Optional because the brief must still render before (or without) wealth data. Detectors that
   * need it return no insights when it is absent — silence is correct here, since a wealth line
   * inferred from missing data would be a false claim about real money.
   */
  wealth?: WealthBrief
}

/** A detector is a pure function: context in, insights out */
export type Detector = (ctx: DetectorContext) => Insight[]
