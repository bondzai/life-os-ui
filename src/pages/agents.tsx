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
import { relativeTime } from '@/lib/dates'
import { useAgentStream, type Agent, type Link } from '@/core/hooks/use-agent-stream'

/** How the link badge reads. Colour repeats the word; it never carries it alone. */
const LINK_COPY: Record<Link, { label: string; tone: string }> = {
  live: { label: 'Live', tone: 'text-emerald-700 dark:text-emerald-500' },
  connecting: { label: 'Connecting…', tone: 'text-muted-foreground' },
  retrying: { label: 'Reconnecting…', tone: 'text-amber-600 dark:text-amber-500' },
  polling: { label: 'Polling — socket unavailable', tone: 'text-amber-600 dark:text-amber-500' },
}

export function AgentsPage() {
  const { agents, link } = useAgentStream()
  const working = agents.filter((a) => a.status === 'working').length

  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center gap-x-8 gap-y-4 py-4">
          <div className="min-w-[8rem]">
            <p className="text-xs tracking-wide text-muted-foreground uppercase">Working</p>
            <p className="text-2xl leading-tight font-semibold tabular-nums">
              {working}
              <span className="text-base font-normal text-muted-foreground"> / {agents.length}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {agents.length === 1 ? 'agent' : 'agents'} on the fleet
            </p>
          </div>

          <div>
            <p className="text-xs tracking-wide text-muted-foreground uppercase">Connection</p>
            <p className={cn('flex items-center gap-1.5 font-medium', LINK_COPY[link].tone)}>
              <Circle
                className={cn('size-2 fill-current', link === 'live' && 'animate-pulse')}
                aria-hidden
              />
              {LINK_COPY[link].label}
            </p>
            <p className="text-xs text-muted-foreground">
              {link === 'live' ? 'updates arrive as they happen' : 'the page keeps retrying'}
            </p>
          </div>

          <div>
            <p className="text-xs tracking-wide text-muted-foreground uppercase">Completed</p>
            <p className="font-medium tabular-nums">
              {agents.reduce((sum, a) => sum + a.done, 0)}
            </p>
            <p className="text-xs text-muted-foreground">since the server started</p>
          </div>

          {agents.some((a) => a.failed > 0) && (
            <div>
              <p className="text-xs tracking-wide text-muted-foreground uppercase">Failed</p>
              <p className="font-medium tabular-nums text-red-700 dark:text-red-400">
                {agents.reduce((sum, a) => sum + a.failed, 0)}
              </p>
              <p className="text-xs text-muted-foreground">jobs that gave up</p>
            </div>
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
    </div>
  )
}

function AgentRow({ agent }: { agent: Agent }) {
  const working = agent.status === 'working'

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
      <span
        className={cn(
          'size-2 shrink-0 rounded-full',
          working ? 'animate-pulse bg-emerald-500' : 'bg-muted-foreground/30',
        )}
        role="img"
        aria-label={working ? 'working' : 'idle'}
      />

      <div className="min-w-0 flex-1">
        {/* The lane is the agent's job title and the id is its badge number. The lane leads,
            because "which deliver worker" is a question you almost never have. */}
        <p className="font-medium capitalize">{agent.lane}</p>
        <p className="truncate font-mono text-[11px] text-muted-foreground">{agent.id}</p>
      </div>

      <div className="min-w-0 flex-[2]">
        {working && agent.job ? (
          <>
            <p className="truncate text-sm">{agent.job.kind}</p>
            <p className="text-xs text-muted-foreground">
              <Elapsed since={agent.job.started_at} />
              {agent.job.attempt > 1 && ` · attempt ${agent.job.attempt}`}
            </p>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            idle · {relativeTime(new Date(agent.last_seen * 1000).toISOString())}
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

  const secs = Math.max(0, Math.floor(now - since))
  if (secs < 60) return <>running {secs}s</>
  const mins = Math.floor(secs / 60)
  if (mins < 60) return <>running {mins}m {secs % 60}s</>
  return <>running {Math.floor(mins / 60)}h {mins % 60}m</>
}
