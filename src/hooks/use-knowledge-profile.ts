/**
 * Knowledge Profile hook — aggregates notes, ideas, decisions, questions,
 * journal entries, skills, and relations into a single analytical profile.
 * Consumed by AI context builders and future agents.
 */

import { useMemo } from 'react'
import { useEntities, useRelations } from '@/core/hooks'
import type { Entity } from '@/core/types'
import type { Relation } from '@/core/types'

// ── Public types ──

export interface ThemeCount {
  theme: string
  count: number
  /** Occurrences in the last 14 days */
  recentCount: number
}

export interface ProjectInsight {
  project: Entity
  noteCount: number
  decisionCount: number
  ideaCount: number
  taskCount: number
  /** Tasks completed this week */
  velocity: number
  lastActivity: string
}

export interface KnowledgeGap {
  entity: Entity
  missingSkill: string
}

export interface KnowledgeProfile {
  topThemes: ThemeCount[]
  unactionedIdeas: { entity: Entity; daysOld: number }[]
  unreviewedDecisions: { entity: Entity; daysSinceDecision: number }[]
  openQuestions: Entity[]
  recurringConcerns: { theme: string; entryCount: number; lastMentioned: string }[]
  knowledgeGaps: KnowledgeGap[]
  /** Notes/ideas created per ISO week for the last 8 weeks */
  thinkingVelocity: { week: string; count: number }[]
  staleKnowledge: Entity[]
  projectInsights: ProjectInsight[]
  /** Notes/ideas with zero relations */
  orphanEntities: Entity[]
  totalNotes: number
  totalDecisions: number
  totalIdeas: number
}

// ── Helpers ──

const DAY_MS = 86_400_000
const WEEK_MS = 7 * DAY_MS

function daysBetween(from: string, to: Date): number {
  return Math.floor((to.getTime() - new Date(from).getTime()) / DAY_MS)
}

function startOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  d.setHours(0, 0, 0, 0)
  return d
}

/** Return ISO-week label like "2026-W12" */
function isoWeekLabel(date: Date): string {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const jan4 = new Date(d.getFullYear(), 0, 4)
  const weekNum = 1 + Math.round(((d.getTime() - jan4.getTime()) / DAY_MS - 3 + ((jan4.getDay() + 6) % 7)) / 7)
  return `${d.getFullYear()}-W${String(weekNum).padStart(2, '0')}`
}

function isTerminal(status: string): boolean {
  return status === 'done' || status === 'archived'
}

function hasTag(tags: string[], ...needles: string[]): boolean {
  return tags.some((t) => {
    const lower = t.toLowerCase()
    return needles.some((n) => lower.includes(n))
  })
}

// ── Hook ──

export function useKnowledgeProfile(): KnowledgeProfile {
  const { items: entities } = useEntities()
  const { items: relations } = useRelations()

  return useMemo(() => {
    const now = new Date()
    const todayISO = now.toISOString().split('T')[0]
    const fourteenDaysAgo = new Date(now.getTime() - 14 * DAY_MS)
    const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS)
    const thisWeekStart = startOfWeek(now)
    const thisWeekISO = thisWeekStart.toISOString()

    // ── Pre-index entities by type ──
    const notes: Entity[] = []
    const ideas: Entity[] = []
    const decisions: Entity[] = []
    const journals: Entity[] = []
    const questions: Entity[] = []
    const skills: Entity[] = []
    const goals: Entity[] = []
    const projects: Entity[] = []
    const tasks: Entity[] = []

    for (const e of entities) {
      if (e.type === 'note') {
        notes.push(e)
        if (hasTag(e.tags, 'idea', 'spark')) ideas.push(e)
        if (e.metadata?.isDecision === true) decisions.push(e)
        if (e.metadata?.isJournal === true) journals.push(e)
        if (hasTag(e.tags, 'question')) questions.push(e)
      } else if (e.type === 'skill') {
        skills.push(e)
      } else if (e.type === 'goal') {
        goals.push(e)
      } else if (e.type === 'project') {
        projects.push(e)
      } else if (e.type === 'task') {
        tasks.push(e)
      }
    }

    // ── Relation indices ──
    const relatedFromIds = new Set<string>()
    const relatedToIds = new Set<string>()
    const relatedIds = new Set<string>()
    for (const r of relations) {
      relatedFromIds.add(r.fromId)
      relatedToIds.add(r.toId)
      relatedIds.add(r.fromId)
      relatedIds.add(r.toId)
    }

    // Build a set of task-linked note IDs (via metadata reference)
    const taskLinkedNoteIds = new Set<string>()
    for (const t of tasks) {
      const ref = t.metadata?.noteId as string | undefined
      if (ref) taskLinkedNoteIds.add(ref)
    }

    // ── 1. Top themes ──
    const knowledgeEntities = [...notes, ...ideas, ...decisions, ...journals]
    const tagCounts = new Map<string, { count: number; recentCount: number }>()

    for (const e of knowledgeEntities) {
      const isRecent = new Date(e.createdAt) >= fourteenDaysAgo
      for (const tag of e.tags) {
        const lower = tag.toLowerCase()
        const entry = tagCounts.get(lower) ?? { count: 0, recentCount: 0 }
        entry.count++
        if (isRecent) entry.recentCount++
        tagCounts.set(lower, entry)
      }
    }

    const topThemes: ThemeCount[] = Array.from(tagCounts.entries())
      .map(([theme, { count, recentCount }]) => ({ theme, count, recentCount }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15)

    // ── 2. Unactioned ideas ──
    const unactionedIdeas = ideas
      .filter((e) => {
        if (isTerminal(e.status)) return false
        // Has a relation or a task referencing it?
        if (relatedFromIds.has(e.id) || taskLinkedNoteIds.has(e.id)) return false
        return true
      })
      .map((entity) => ({ entity, daysOld: daysBetween(entity.createdAt, now) }))
      .sort((a, b) => b.daysOld - a.daysOld)

    // ── 3. Unreviewed decisions ──
    const unreviewedDecisions = decisions
      .filter((e) => {
        if (e.metadata?.revisitStatus !== 'pending') return false
        const revisitDate = e.metadata?.revisitDate as string | undefined
        if (!revisitDate) return false
        return revisitDate <= todayISO
      })
      .map((entity) => ({
        entity,
        daysSinceDecision: daysBetween(entity.createdAt, now),
      }))
      .sort((a, b) => b.daysSinceDecision - a.daysSinceDecision)

    // ── 4. Open questions ──
    const openQuestions = questions.filter((e) => !isTerminal(e.status))

    // ── 5. Recurring concerns ──
    const journalTagEntries = new Map<string, { count: number; lastDate: string }>()
    for (const j of journals) {
      for (const tag of j.tags) {
        const lower = tag.toLowerCase()
        const entry = journalTagEntries.get(lower)
        if (!entry) {
          journalTagEntries.set(lower, { count: 1, lastDate: j.createdAt })
        } else {
          entry.count++
          if (j.createdAt > entry.lastDate) entry.lastDate = j.createdAt
        }
      }
    }

    const recurringConcerns = Array.from(journalTagEntries.entries())
      .filter(([, v]) => v.count >= 3)
      .map(([theme, v]) => ({
        theme,
        entryCount: v.count,
        lastMentioned: v.lastDate.split('T')[0],
      }))
      .sort((a, b) => b.entryCount - a.entryCount)

    // ── 6. Knowledge gaps ──
    const skillNames = new Set(skills.map((s) => s.title.toLowerCase()))
    const noviceSkills = new Set(
      skills
        .filter((s) => (s.metadata?.mastery as string) === 'novice')
        .map((s) => s.title.toLowerCase()),
    )

    const knowledgeGaps: KnowledgeGap[] = []
    const goalAndProjects = [...goals, ...projects].filter((e) => !isTerminal(e.status))

    for (const entity of goalAndProjects) {
      // Check each tag as a potential skill reference
      for (const tag of entity.tags) {
        const lower = tag.toLowerCase()
        if (!skillNames.has(lower) || noviceSkills.has(lower)) {
          // Only flag if the tag looks like it could be a skill
          // (skip generic tags by requiring length > 2)
          if (lower.length > 2 && !['todo', 'wip', 'done', 'high', 'low', 'medium', 'urgent'].includes(lower)) {
            // Check if this is a missing skill (not existing) or novice
            if (!skillNames.has(lower) || noviceSkills.has(lower)) {
              knowledgeGaps.push({ entity, missingSkill: tag })
            }
          }
        }
      }
    }

    // ── 7. Thinking velocity (last 8 weeks) ──
    const eightWeeksAgo = new Date(now.getTime() - 8 * WEEK_MS)
    const weekCounts = new Map<string, number>()

    // Pre-fill last 8 week labels
    for (let i = 7; i >= 0; i--) {
      const d = new Date(now.getTime() - i * WEEK_MS)
      weekCounts.set(isoWeekLabel(d), 0)
    }

    for (const e of knowledgeEntities) {
      const created = new Date(e.createdAt)
      if (created < eightWeeksAgo) continue
      const label = isoWeekLabel(created)
      if (weekCounts.has(label)) {
        weekCounts.set(label, (weekCounts.get(label) ?? 0) + 1)
      }
    }

    const thinkingVelocity = Array.from(weekCounts.entries())
      .map(([week, count]) => ({ week, count }))
      .sort((a, b) => a.week.localeCompare(b.week))

    // ── 8. Stale knowledge ──
    const staleKnowledge = notes.filter((e) => {
      if (isTerminal(e.status)) return false
      if (e.metadata?.isJournal === true) return false
      if (e.metadata?.isInbox === true) return false
      return new Date(e.updatedAt) < thirtyDaysAgo
    })

    // ── 9. Project insights ──
    const projectInsights: ProjectInsight[] = projects
      .filter((p) => !isTerminal(p.status))
      .map((project) => {
        // Notes related to project via relations
        const relatedNoteIds = relations
          .filter(
            (r: Relation) =>
              (r.fromId === project.id || r.toId === project.id),
          )
          .map((r: Relation) => (r.fromId === project.id ? r.toId : r.fromId))

        const relatedNotes = relatedNoteIds
          .map((id) => entities.find((e) => e.id === id && e.type === 'note'))
          .filter(Boolean) as Entity[]

        const noteCount = relatedNotes.length
        const decisionCount = relatedNotes.filter((n) => n.metadata?.isDecision === true).length
        const ideaCount = relatedNotes.filter((n) => hasTag(n.tags, 'idea', 'spark')).length

        // Tasks linked to this project
        const projectTasks = tasks.filter((t) => t.metadata?.projectId === project.id)
        const taskCount = projectTasks.length

        // Velocity: tasks done this week
        const velocity = projectTasks.filter(
          (t) => t.status === 'done' && t.updatedAt >= thisWeekISO,
        ).length

        // Last activity across all linked entities
        const allDates = [
          project.updatedAt,
          ...relatedNotes.map((n) => n.updatedAt),
          ...projectTasks.map((t) => t.updatedAt),
        ]
        const lastActivity = allDates.sort().pop() ?? project.updatedAt

        return {
          project,
          noteCount,
          decisionCount,
          ideaCount,
          taskCount,
          velocity,
          lastActivity: lastActivity.split('T')[0],
        }
      })
      .sort((a, b) => b.velocity - a.velocity || b.noteCount - a.noteCount)

    // ── 10. Orphan entities ──
    const orphanEntities = [...notes, ...ideas].filter(
      (e) => !isTerminal(e.status) && !relatedIds.has(e.id),
    )

    // ── Totals ──
    const totalNotes = notes.length
    const totalDecisions = decisions.length
    const totalIdeas = ideas.length

    return {
      topThemes,
      unactionedIdeas,
      unreviewedDecisions,
      openQuestions,
      recurringConcerns,
      knowledgeGaps,
      thinkingVelocity,
      staleKnowledge,
      projectInsights,
      orphanEntities,
      totalNotes,
      totalDecisions,
      totalIdeas,
    }
  }, [entities, relations])
}
