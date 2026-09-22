/**
 * Agents — who is working for you right now.
 *
 * The four questions this screen answers, in the order the eye hits them: **how many are working**,
 * **is the picture live**, **what is each one doing**, and **has any of them been failing**.
 * Everything else was left out; a fleet view that needs reading is a fleet view you stop opening.
 *
 * It is a list, not a grid of cards. Four agents today and a dozen later is a column you scan, and
 * comparison between rows — who has been idle, who is failing — only works when they line up.
 *
 * The connection state is on the page rather than hidden, because "nothing is happening" and "we
 * lost the socket" look identical and mean opposite things.
 */

import { useEffect, useState } from 'react'
import { Bot, Circle } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/core/components/empty-state'
import { cn } from '@/lib/utils'
import { formatDuration, formatRelativeTime } from '@/pages/wealth/format'
import { useAgentStream, type Agent, type Link } from '@/core/hooks/use-agent-stream'
import { useJobAction, useQueue, type QueuedJob } from '@/core/hooks/use-queue'

/** How the link badge reads. Colour repeats the word; it never carries it alone. */
const LINK_COPY: Record<Link, { label: string; tone: string }> = {
  live: { label: 'Live', tone: 'text-emerald-700 dark:text-emerald-500' },
  connecting: { label: 'Connecting…', tone: 'text-muted-foreground' },
  retrying: { label: 'Reconnecting…', tone: 'text-amber-600 dark:text-amber-500' },
  // Said as what you experience, not how it is built: "socket unavailable" was the transport's
  // name for the problem, and the reader does not have a socket — they have a page that stopped
  // updating on its own.
  polling: { label: 'Live updates paused', tone: 'text-amber-600 dark:text-amber-500' },
}

/**
 * The words for what the queue calls lanes and kinds.
 *
 * `batch` and `deliver.telegram` are the system's names — right in a log, wrong on a page you read
 * to find out what your assistant is doing. The raw value stays on hover for when you are
 * debugging, and anything unrecognised falls back to it rather than vanishing.
 */
const LANE_LABEL: Record<string, string> = {
  interactive: 'Quick tasks',
  batch: 'Background',
  deliver: 'Messages',
}
const KIND_LABEL: Record<string, string> = {
  'deliver.telegram': 'Send a message',
  'digest.daily': 'Daily brief',
  'snapshot.networth': 'Net-worth snapshot',
  'schedule.tick': 'Habits nudge',
}
const laneLabel = (lane: string) => LANE_LABEL[lane] ?? lane
const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind

/** Seconds as a short span. `formatDuration` stops at minutes; a live page needs the seconds. */
function formatElapsed(seconds: number): string {
  return seconds < 60 ? `${Math.max(0, Math.floor(seconds))}s` : formatDuration(seconds)
}

export function AgentsPage() {
  const { agents, link } = useAgentStream()
  const { data: queue, isError: queueUnreadable } = useQueue()
  const working = agents.filter((a) => a.status === 'working').length
  const failed = queue?.counts.failed ?? 0

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-4 py-4">
          <Stat
            primary
            label="Working"
            value={
              <>
                {working}
                <span className="text-base font-normal text-muted-foreground"> / {agents.length}</span>
              </>
            }
            caption={`${agents.length === 1 ? 'agent' : 'agents'} on the fleet`}
          />
          <Stat
            label="Connection"
            tone={LINK_COPY[link].tone}
            value={
              <span className="flex items-center gap-1.5">
                <Circle
                  className={cn('size-2 fill-current', link === 'live' && 'motion-safe:animate-pulse')}
                  aria-hidden
                />
                {LINK_COPY[link].label}
              </span>
            }
            caption={link === 'live' ? 'updates arrive as they happen' : 'the page keeps retrying'}
          />
          <Stat
            label="Completed"
            value={agents.reduce((sum, a) => sum + a.done, 0)}
            caption="since the server started"
          />
          {/* The oldest runnable wait is the one number that says whether the workers are keeping
              up. A job scheduled for tomorrow is not a backlog and is not counted. And a queue that
              could not be read says so, rather than showing a dash that looks like "nothing". */}
          <Stat
            label="Queued"
            value={queue?.counts.queued ?? '—'}
            tone={queueUnreadable ? 'text-red-700 dark:text-red-400' : undefined}
            caption={
              queueUnreadable
                ? 'could not read the queue — retrying'
                : queue?.oldest_queued_secs != null
                  ? `oldest waiting ${formatElapsed(queue.oldest_queued_secs)}`
                  : 'nothing waiting'
            }
          />
          {failed > 0 && (
            <Stat
              label="Failed"
              value={failed}
              tone="text-red-700 dark:text-red-400"
              caption="out of attempts — retry below"
            />
          )}
        </CardContent>
      </Card>

      {agents.length === 0 ? (
        <EmptyState
          icon={Bot}
          title={link === 'live' ? 'No agents running' : 'Waiting for the fleet'}
          description={
            link === 'live'
              ? 'Workers register themselves when the server starts them. If this stays empty, the queue is switched off — check LYRA_JOBS.'
              : 'Connecting to the server. If this does not clear, the API is not running.'
          }
        />
      ) : (
        <ul className="divide-y rounded-lg border">
          {agents.map((agent) => (
            <AgentRow key={agent.id} agent={agent} />
          ))}
        </ul>
      )}

      {/* Below the fleet, not above it: what is running is the question you came with, and what
          just ran is the one you ask second. Absent entirely on a queue nothing has touched, so a
          fresh box is not a page of empty headings. */}
      {queue && queue.recent.length > 0 && <RecentJobs jobs={queue.recent} />}
    </div>
  )
}

/** One figure on the summary bar: a label, the number, and the caveat the number needs. */
function Stat({
  label,
  value,
  caption,
  tone,
  primary,
}: {
  label: string
  value: React.ReactNode
  caption: string
  tone?: string
  /** The figure read first — larger, and the only one given a minimum width. */
  primary?: boolean
}) {
  return (
    <div className={cn(primary && 'min-w-[8rem]')}>
      <p className="text-xs tracking-wide text-muted-foreground uppercase">{label}</p>
      <p
        className={cn(
          'tabular-nums',
          primary ? 'text-2xl leading-tight font-semibold' : 'font-medium',
          tone,
        )}
      >
        {value}
      </p>
      <p className="text-xs text-muted-foreground">{caption}</p>
    </div>
  )
}

const JOB_TONE: Record<QueuedJob['status'], string> = {
  running: 'text-emerald-700 dark:text-emerald-500',
  queued: 'text-muted-foreground',
  done: 'text-muted-foreground',
  failed: 'text-red-700 dark:text-red-400',
  cancelled: 'text-muted-foreground',
}

/**
 * The one action a job's state allows, or none.
 *
 * Never both, and never the wrong one: Retry on a queued job would run it twice, and Cancel on a
 * running one cannot be honoured — pulling the rug mid-handler leaves a half-sent message.
 */
function actionFor(status: QueuedJob['status']): { action: 'retry' | 'cancel'; label: string } | null {
  if (status === 'failed' || status === 'cancelled') return { action: 'retry', label: 'Retry' }
  if (status === 'queued') return { action: 'cancel', label: 'Cancel' }
  return null
}

function RecentJobs({ jobs }: { jobs: QueuedJob[] }) {
  const action = useJobAction()

  return (
    <section className="space-y-2">
      <h2 className="text-xs tracking-wide text-muted-foreground uppercase">Recent work</h2>
      {action.isError && (
        <p role="alert" className="text-xs text-red-700 dark:text-red-400">
          {action.error.message}
        </p>
      )}
      <ul className="divide-y rounded-lg border">
        {jobs.map((job) => {
          const next = actionFor(job.status)
          return (
            <li key={job.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-4 py-2">
              <span className="min-w-0 flex-1 truncate text-sm" title={job.kind}>
                {kindLabel(job.kind)}
              </span>
              <span className="text-xs text-muted-foreground" title={job.lane}>
                {laneLabel(job.lane)}
              </span>
              {/* The attempt count only appears once it is more than one, because "1/5" on every
                  row is four characters of noise that mean "nothing has gone wrong". */}
              {job.attempts > 1 && (
                <span className="text-xs tabular-nums text-muted-foreground">
                  {job.attempts}/{job.max_attempts}
                </span>
              )}
              <span className={cn('text-xs font-medium', JOB_TONE[job.status])}>{job.status}</span>
              {next && (
                <JobButton
                  label={next.label}
                  busy={action.isPending && action.variables?.id === job.id}
                  onClick={() => action.mutate({ id: job.id, action: next.action })}
                />
              )}
              {/* Why it died is the whole reason the row is kept rather than pruned. */}
              {job.last_error && job.status === 'failed' && (
                <p className="w-full truncate text-xs text-muted-foreground" title={job.last_error}>
                  {job.last_error}
                </p>
              )}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

function AgentRow({ agent }: { agent: Agent }) {
  const working = agent.status === 'working'

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          working ? 'bg-emerald-500 motion-safe:animate-pulse' : 'bg-muted-foreground/30',
        )}
        role="img"
        aria-label={working ? 'working' : 'idle'}
      />

      <div className="min-w-0 flex-1">
        {/* The lane is the agent's job title and the id is its badge number. The lane leads,
            because "which background worker" is a question you almost never have. */}
        <p className="font-medium" title={agent.lane}>
          {laneLabel(agent.lane)}
        </p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">{agent.id}</p>
      </div>

      <div className="min-w-0 flex-[2]">
        {working && agent.job ? (
          <>
            <p className="truncate text-sm" title={agent.job.kind}>
              {kindLabel(agent.job.kind)}
            </p>
            <p className="text-xs text-muted-foreground">
              <Elapsed since={agent.job.started_at} />
              {agent.job.attempt > 1 && ` · attempt ${agent.job.attempt}`}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            idle · {formatRelativeTime(agent.last_seen)}
          </p>
        )}
      </div>

      <div className="text-right text-xs tabular-nums">
        <p className="text-muted-foreground">{agent.done} done</p>
        {agent.failed > 0 && (
          <p className="text-red-700 dark:text-red-400">{agent.failed} failed</p>
        )}
      </div>
    </li>
  )
}

/**
 * How long the current job has been running, ticking.
 *
 * A static "started 2m ago" on a live page is the one thing that makes it look frozen, which is
 * the exact impression this screen exists to dispel. One second is the cheapest possible tick and
 * only mounts while something is actually running.
 */
function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(() => Date.now() / 1000)

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() / 1000), 1000)
    return () => clearInterval(id)
  }, [])

  return <>running {formatElapsed(now - since)}</>
}

/**
 * A small text button for a row action.
 *
 * Quiet on purpose — these sit on every failed or queued row, and a column of solid buttons would
 * shout louder than the statuses they act on. The *visible* button stays small; the hit area does
 * not. A `before` layer extends it to 44px tall, because a small target on a phone is a mis-tap on
 * the row below, and a mis-tapped Retry re-sends a message.
 */
function JobButton({ label, busy, onClick }: { label: string; busy: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy}
      className="relative -my-1 rounded px-2 py-1 text-xs font-medium text-primary before:absolute before:-inset-x-1 before:-inset-y-2.5 hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:opacity-50"
    >
      {busy ? `${label}…` : label}
    </button>
  )
}
