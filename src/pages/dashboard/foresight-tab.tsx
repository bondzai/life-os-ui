import { useState, useCallback, useMemo } from 'react'
import {
  AlertTriangle,
  Link2,
  GitBranch,
  Sparkles,
  RefreshCw,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
// Progress unused for now but available for future enhancement
import { Markdown } from '@/core/components/markdown'
import { LyraLoader } from '@/components/lyra-loader'
import { useAI } from '@/hooks/use-ai'
import { useMorningBrief } from '@/hooks/use-morning-brief'
import { useScenarios, type EntityScenario } from '@/hooks/use-scenarios'

/* ─── Session cache key ─── */

function todayKey(): string {
  return `lyra-connections-${new Date().toISOString().split('T')[0]}`
}

/* ─── Severity helpers ─── */

function severityColor(severity: number): string {
  if (severity >= 3) return 'border-red-500/40 bg-red-500/5'
  if (severity >= 2) return 'border-amber-500/40 bg-amber-500/5'
  return 'border-border'
}

function severityBadge(severity: number) {
  if (severity >= 3)
    return (
      <Badge variant="destructive" className="text-[10px]">
        Critical
      </Badge>
    )
  if (severity >= 2)
    return (
      <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 text-[10px]">
        Important
      </Badge>
    )
  return (
    <Badge variant="secondary" className="text-[10px]">
      Info
    </Badge>
  )
}

/* ─── Scenario bar visualization ─── */

function ScenarioBar({ scenario }: { scenario: EntityScenario }) {
  const maxWeeks = Math.max(
    scenario.optimistic.weeksNeeded,
    scenario.realistic.weeksNeeded,
    scenario.pessimistic.weeksNeeded,
    1,
  )

  const bars = [
    {
      label: 'Optimistic',
      weeks: scenario.optimistic.weeksNeeded,
      date: scenario.optimistic.projectedDate,
      color: 'bg-green-500',
    },
    {
      label: 'Realistic',
      weeks: scenario.realistic.weeksNeeded,
      date: scenario.realistic.projectedDate,
      color: 'bg-amber-500',
    },
    {
      label: 'Pessimistic',
      weeks: scenario.pessimistic.weeksNeeded,
      date: scenario.pessimistic.projectedDate,
      color: 'bg-red-500',
    },
  ]

  // Determine risk status based on due date
  const riskBadge = useMemo(() => {
    if (!scenario.dueDate) return null
    const due = new Date(scenario.dueDate).getTime()
    const optimistic = new Date(scenario.optimistic.projectedDate).getTime()
    const realistic = new Date(scenario.realistic.projectedDate).getTime()

    if (realistic <= due)
      return (
        <Badge className="bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30 text-[10px]">
          On track
        </Badge>
      )
    if (optimistic <= due)
      return (
        <Badge className="bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30 text-[10px]">
          At risk
        </Badge>
      )
    return (
      <Badge variant="destructive" className="text-[10px]">
        Will miss
      </Badge>
    )
  }, [scenario])

  return (
    <Card className="p-4 gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{scenario.entity.title}</span>
        <div className="flex items-center gap-2">
          {riskBadge}
          {scenario.dueDate && (
            <span className="text-[10px] text-muted-foreground">
              Due {new Date(scenario.dueDate).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>
      <div className="space-y-1.5 mt-2">
        {bars.map((bar) => (
          <div key={bar.label} className="flex items-center gap-2">
            <span className="text-[10px] text-muted-foreground w-[70px] shrink-0">
              {bar.label}
            </span>
            <div className="flex-1 h-3 bg-muted rounded-full overflow-hidden relative">
              <div
                className={`h-full rounded-full ${bar.color} opacity-70`}
                style={{
                  width: `${Math.max(5, (bar.weeks / maxWeeks) * 100)}%`,
                }}
              />
              {/* Due date marker */}
              {scenario.dueDate && (() => {
                const dueWeeks =
                  (new Date(scenario.dueDate!).getTime() - Date.now()) /
                  (7 * 86400000)
                const pos = Math.min(100, Math.max(0, (dueWeeks / maxWeeks) * 100))
                return (
                  <div
                    className="absolute top-0 h-full w-0.5 bg-foreground/40"
                    style={{ left: `${pos}%` }}
                  />
                )
              })()}
            </div>
            <span className="text-[10px] text-muted-foreground w-[72px] text-right shrink-0">
              {new Date(bar.date).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
              })}
            </span>
          </div>
        ))}
      </div>
    </Card>
  )
}

/* ─── Foresight Tab ─── */

export function ForesightTab() {
  const { run, isOnline } = useAI()
  const insights = useMorningBrief()
  const scenarios = useScenarios()

  const [connectionsMarkdown, setConnectionsMarkdown] = useState<string>(
    () => sessionStorage.getItem(todayKey()) ?? '',
  )
  const [loading, setLoading] = useState(false)

  // Filter threat insights
  const threats = useMemo(
    () => insights.filter((i) => i.id.startsWith('threat-')),
    [insights],
  )

  // Generate connections
  const generateConnections = useCallback(async () => {
    setLoading(true)
    try {
      const result = await run('find-connections')
      setConnectionsMarkdown(result)
      sessionStorage.setItem(todayKey(), result)
    } catch {
      setConnectionsMarkdown(
        'Failed to generate connections. Check your AI configuration.',
      )
    } finally {
      setLoading(false)
    }
  }, [run])

  return (
    <div className="space-y-8 pb-8">
      {/* ─── Section 1: Threats ─── */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="h-4 w-4 text-amber-500" />
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Threats
          </h2>
          {threats.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {threats.length}
            </Badge>
          )}
        </div>

        {threats.length === 0 ? (
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">
              No active threats detected. All clear.
            </p>
          </Card>
        ) : (
          <div className="space-y-2">
            {threats.map((threat) => (
              <Card
                key={threat.id}
                className={`p-4 border ${severityColor(threat.severity)}`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      {severityBadge(threat.severity)}
                      <span className="text-sm font-medium">
                        {threat.title}
                      </span>
                    </div>
                    {threat.detail && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {threat.detail}
                      </p>
                    )}
                  </div>
                  {threat.actionLabel && threat.actionPath && (
                    <Button variant="ghost" size="sm" className="shrink-0 text-xs" asChild>
                      <a href={threat.actionPath}>{threat.actionLabel}</a>
                    </Button>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* ─── Section 2: Connections ─── */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <Link2 className="h-4 w-4 text-blue-500" />
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              Connections
            </h2>
          </div>
          {isOnline && (
            <Button
              variant="ghost"
              size="sm"
              className="gap-1.5 text-xs"
              onClick={generateConnections}
              disabled={loading}
            >
              {connectionsMarkdown ? (
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
              ) : (
                <Sparkles className="h-3 w-3" />
              )}
              {connectionsMarkdown ? 'Refresh' : 'Generate'}
            </Button>
          )}
        </div>

        {loading ? (
          <Card className="p-8 flex items-center justify-center">
            <LyraLoader />
          </Card>
        ) : connectionsMarkdown ? (
          <Card className="p-4">
            <Markdown content={connectionsMarkdown} />
          </Card>
        ) : (
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">
              {isOnline
                ? 'Click Generate to discover hidden connections across your knowledge.'
                : 'Connect Lyra to discover hidden connections.'}
            </p>
          </Card>
        )}
      </section>

      {/* ─── Section 3: Scenarios ─── */}
      <section>
        <div className="flex items-center gap-2 mb-3">
          <GitBranch className="h-4 w-4 text-violet-500" />
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            Scenarios
          </h2>
          {scenarios.length > 0 && (
            <Badge variant="secondary" className="text-[10px]">
              {scenarios.length}
            </Badge>
          )}
        </div>

        {scenarios.length === 0 ? (
          <Card className="p-4">
            <p className="text-sm text-muted-foreground">
              No active projects or goals with enough data for scenario
              projection.
            </p>
          </Card>
        ) : (
          <div className="space-y-2">
            {scenarios.map((scenario) => (
              <ScenarioBar key={scenario.entity.id} scenario={scenario} />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
