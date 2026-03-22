/**
 * Builds a plain-text knowledge context block from a KnowledgeProfile.
 * Designed for injection into AI agent system prompts.
 */

import type { KnowledgeProfile } from '@/hooks/use-knowledge-profile'

export function buildKnowledgeContext(profile: KnowledgeProfile): string {
  const lines: string[] = ['## Knowledge Profile']

  // Top themes
  if (profile.topThemes.length > 0) {
    lines.push(
      '\nTop themes: ' +
        profile.topThemes
          .slice(0, 10)
          .map((t) => `${t.theme} (${t.count}, ${t.recentCount} recent)`)
          .join(', '),
    )
  }

  // Unactioned ideas
  if (profile.unactionedIdeas.length > 0) {
    lines.push(`\nUnactioned ideas (${profile.unactionedIdeas.length}):`)
    for (const i of profile.unactionedIdeas.slice(0, 5)) {
      lines.push(`  - "${i.entity.title}" (${i.daysOld}d old)`)
    }
  }

  // Unreviewed decisions
  if (profile.unreviewedDecisions.length > 0) {
    lines.push(`\nUnreviewed decisions (${profile.unreviewedDecisions.length}):`)
    for (const d of profile.unreviewedDecisions.slice(0, 5)) {
      lines.push(`  - "${d.entity.title}" (${d.daysSinceDecision}d since decision)`)
    }
  }

  // Open questions
  if (profile.openQuestions.length > 0) {
    lines.push(`\nOpen questions (${profile.openQuestions.length}):`)
    for (const q of profile.openQuestions.slice(0, 5)) {
      lines.push(`  - "${q.title}"`)
    }
  }

  // Recurring concerns
  if (profile.recurringConcerns.length > 0) {
    lines.push(`\nRecurring concerns:`)
    for (const c of profile.recurringConcerns) {
      lines.push(`  - "${c.theme}" (${c.entryCount} entries, last: ${c.lastMentioned})`)
    }
  }

  // Knowledge gaps
  if (profile.knowledgeGaps.length > 0) {
    lines.push(`\nKnowledge gaps:`)
    for (const g of profile.knowledgeGaps) {
      lines.push(`  - ${g.entity.title} needs: ${g.missingSkill}`)
    }
  }

  // Project knowledge
  if (profile.projectInsights.length > 0) {
    lines.push(`\nProject knowledge:`)
    for (const p of profile.projectInsights) {
      lines.push(
        `  - ${p.project.title}: ${p.noteCount} notes, ${p.decisionCount} decisions, ${p.ideaCount} ideas, ${p.velocity}/wk velocity`,
      )
    }
  }

  // Summary stats
  lines.push(
    `\nKnowledge stats: ${profile.totalNotes} notes, ${profile.totalDecisions} decisions, ${profile.totalIdeas} ideas, ${profile.orphanEntities.length} orphan items, ${profile.staleKnowledge.length} stale`,
  )

  // Thinking velocity
  if (profile.thinkingVelocity.length > 0) {
    const recent = profile.thinkingVelocity[profile.thinkingVelocity.length - 1]?.count ?? 0
    const prev = profile.thinkingVelocity[profile.thinkingVelocity.length - 2]?.count ?? 0
    const arrow = recent > prev ? '\u2191' : recent < prev ? '\u2193' : '\u2192'
    lines.push(`Thinking velocity: ${recent} notes/week (${arrow} from ${prev})`)
  }

  return lines.join('\n')
}
