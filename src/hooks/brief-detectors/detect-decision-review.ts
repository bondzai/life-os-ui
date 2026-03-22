import type { Detector, Insight } from './types'

export const detectDecisionReview: Detector = ({ entities, today }) => {
  const insights: Insight[] = []

  const decisions = entities.filter(
    (e) =>
      e.type === 'note' &&
      e.metadata.isDecision === true &&
      e.metadata.revisitStatus === 'pending' &&
      typeof e.metadata.revisitDate === 'string' &&
      (e.metadata.revisitDate as string) <= today,
  )

  for (const decision of decisions) {
    insights.push({
      id: `decision-review-${decision.id}`,
      type: 'info',
      category: 'decisions',
      severity: 2,
      title: `"${decision.title}" — due for review`,
      detail: typeof decision.metadata.body === 'string' ? (decision.metadata.body as string).slice(0, 80) : undefined,
      actionLabel: 'Review',
      actionPath: '/notes',
      data: { decisionId: decision.id, title: decision.title, revisitDate: decision.metadata.revisitDate },
    })
  }

  return insights
}
