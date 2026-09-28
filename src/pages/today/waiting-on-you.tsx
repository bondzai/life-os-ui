/**
 * Waiting on you — what other systems need decided, at the top of Today.
 *
 * Here rather than on its own page because a decision nobody opens is a decision nobody makes. It
 * is the first thing on the first screen, and it renders nothing at all when the list is empty, so
 * it costs nothing on the days there is nothing to answer.
 *
 * Two rules the markup is built around:
 *
 * **The evidence travels with the question.** A one-tap answer without the reason for it is a
 * coin flip with extra steps, so the line the origin sent is shown next to the buttons.
 *
 * **A tap is recorded, not sent.** The answer is committed in Lyra and delivered by a retrying
 * job, so the state after a tap is "answered — on its way", not "sent". Saying "sent" when the
 * factory is down would be the one lie that matters here.
 */

import { AlertTriangle, Check, Clock, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatRelativeTime } from '@/pages/wealth/format'
import { useAnswerDecision, useDecisions, type Decision } from '@/core/hooks/use-systems'

export function WaitingOnYou() {
  const decisions = useDecisions()

  // Open ones only. What you already decided belongs in a history, not at the top of Today.
  //
  // `?.decisions?.` on both links, not just the first. Written `data?.decisions.filter(...)` at
  // first, which guards a missing response and not a response missing the key — and this component
  // sits at the top of Today, so the one shape it cannot handle takes the whole page with it.
  const all = decisions.data?.decisions ?? []
  const waiting = all.filter((d) => d.answered_at === null)
  const onItsWay = all.filter((d) => d.answered_at !== null && d.delivered_at === null)

  // Nothing waiting renders nothing — including while the first read is in flight, because a
  // skeleton above your day for a panel that is usually empty is worse than a beat of nothing.
  if (waiting.length === 0 && onItsWay.length === 0) return null

  return (
    <section className="space-y-3 rounded-lg border p-4" aria-labelledby="waiting-on-you">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="waiting-on-you" className="font-semibold">
          Waiting on you
        </h2>
        <p className="text-sm text-muted-foreground">
          {waiting.length > 0
            ? `${waiting.length} ${waiting.length === 1 ? 'decision' : 'decisions'}`
            : 'all answered'}
        </p>
      </div>

      <ul className="space-y-3">
        {waiting.map((decision) => (
          <DecisionRow key={decision.id} decision={decision} />
        ))}
      </ul>

      {onItsWay.length > 0 && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          {onItsWay.length} {onItsWay.length === 1 ? 'answer is' : 'answers are'} on the way back
        </p>
      )}
    </section>
  )
}

function DecisionRow({ decision }: { decision: Decision }) {
  const answer = useAnswerDecision()

  return (
    <li className="rounded-md border p-3">
      <p className="font-medium">{decision.question}</p>
      {decision.detail && (
        <p className="mt-0.5 text-sm text-muted-foreground">{decision.detail}</p>
      )}
      {decision.evidence && (
        // The reason, not decoration: this is the difference between deciding and guessing.
        <p className="mt-1.5 text-sm text-muted-foreground">{decision.evidence}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {decision.options.map((option) => (
          <Button
            key={option.value}
            size="sm"
            variant="outline"
            disabled={answer.isPending}
            onClick={() => answer.mutate({ id: decision.id, answer: option.value })}
          >
            {option.label}
          </Button>
        ))}

        <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
          <Clock className="size-3.5" aria-hidden />
          asked {formatRelativeTime(decision.raised_at)}
        </span>
      </div>

      {/* An expiry that has passed is shown rather than hidden: "you missed this" is information,
          and a clean-looking inbox while a factory waits is the failure mode. */}
      {decision.expired && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-500">
          <AlertTriangle className="size-3.5" aria-hidden />
          past its deadline — answering may be too late
        </p>
      )}

      {answer.isSuccess && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-emerald-700 dark:text-emerald-500">
          <Check className="size-3.5" aria-hidden /> answered — on its way back
        </p>
      )}
      {answer.error && (
        <p role="alert" className="mt-2 text-xs text-red-700 dark:text-red-400">
          {answer.error.message}
        </p>
      )}
    </li>
  )
}
