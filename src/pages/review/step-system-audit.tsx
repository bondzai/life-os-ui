import { useState } from 'react'
import {
  TrendingUp,
  TrendingDown,
  Minus,
  AlertTriangle,
  Target,
  FolderKanban,
  Clock,
  Repeat,
  ChevronRight,
  Archive,
  ArrowRight,
  Shield,
  ListOrdered,
} from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import type { Entity } from '@/core/types'
import type {
  ProjectVelocity,
  RiskDetection,
  LifeBalanceItem,
} from './use-system-audit'

interface StepSystemAuditProps {
  projectVelocity: ProjectVelocity[]
  riskDetection: RiskDetection
  lifeBalance: LifeBalanceItem[]
  suggestedPriorities: Entity[]
  onArchive: (item: Entity) => void
  onNavigate?: (item: Entity) => void
}

const STATUS_DOT: Record<string, string> = {
  green: 'bg-green-500',
  yellow: 'bg-amber-500',
  red: 'bg-red-500',
}

const STATUS_BG: Record<string, string> = {
  green: 'border-green-500/20 bg-green-500/5',
  yellow: 'border-amber-500/20 bg-amber-500/5',
  red: 'border-red-500/20 bg-red-500/5',
}

const PRIORITY_VARIANT: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  urgent: 'destructive',
  high: 'default',
  medium: 'secondary',
  low: 'outline',
}

export function StepSystemAudit({
  projectVelocity,
  riskDetection,
  lifeBalance,
  suggestedPriorities,
  onArchive,
  onNavigate,
}: StepSystemAuditProps) {
  const totalRisks =
    riskDetection.habitsAtRisk.length +
    riskDetection.staleGoals.length +
    riskDetection.staleProjects.length +
    riskDetection.overdueTasks.length

  return (
    <div className="space-y-4">
      {/* ── Project Velocity ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <FolderKanban className="h-4 w-4 text-blue-500" />
            Project Velocity
          </CardTitle>
        </CardHeader>
        <CardContent>
          {projectVelocity.length === 0 ? (
            <p className="text-sm text-muted-foreground">No projects found.</p>
          ) : (
            <div className="space-y-2">
              {projectVelocity.map(({ project, thisWeek, lastWeek, delta }) => (
                <div
                  key={project.id}
                  className="flex items-center justify-between rounded-lg border bg-muted/30 px-3 py-2"
                >
                  <span className="text-sm font-medium truncate mr-2">
                    {project.title}
                  </span>
                  <div className="flex items-center gap-3 shrink-0">
                    <span className="text-xs text-muted-foreground">
                      {lastWeek} <ArrowRight className="inline h-3 w-3" /> {thisWeek}
                    </span>
                    <span
                      className={`flex items-center gap-0.5 text-xs font-semibold ${
                        delta > 0
                          ? 'text-green-500'
                          : delta < 0
                            ? 'text-red-500'
                            : 'text-muted-foreground'
                      }`}
                    >
                      {delta > 0 ? (
                        <TrendingUp className="h-3.5 w-3.5" />
                      ) : delta < 0 ? (
                        <TrendingDown className="h-3.5 w-3.5" />
                      ) : (
                        <Minus className="h-3.5 w-3.5" />
                      )}
                      {delta > 0 ? `+${delta}` : delta}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Risk Detection ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <Shield className="h-4 w-4 text-amber-500" />
            Risk Detection
            {totalRisks > 0 && (
              <Badge variant="destructive" className="ml-auto text-[10px] px-1.5 py-0">
                {totalRisks}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          <RiskSection
            icon={<Repeat className="h-3.5 w-3.5 text-purple-500" />}
            label="Habits at Risk"
            items={riskDetection.habitsAtRisk}
            onArchive={onArchive}
            onNavigate={onNavigate}
          />
          <RiskSection
            icon={<Target className="h-3.5 w-3.5 text-amber-500" />}
            label="Stale Goals"
            items={riskDetection.staleGoals}
            onArchive={onArchive}
            onNavigate={onNavigate}
          />
          <RiskSection
            icon={<FolderKanban className="h-3.5 w-3.5 text-blue-500" />}
            label="Stale Projects"
            items={riskDetection.staleProjects}
            onArchive={onArchive}
            onNavigate={onNavigate}
          />
          <RiskSection
            icon={<Clock className="h-3.5 w-3.5 text-red-500" />}
            label="Overdue Tasks"
            items={riskDetection.overdueTasks}
            onArchive={onArchive}
            onNavigate={onNavigate}
          />
          {totalRisks === 0 && (
            <p className="text-sm text-muted-foreground py-2">
              No risks detected. Your system is healthy!
            </p>
          )}
        </CardContent>
      </Card>

      {/* ── Life Balance ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 text-emerald-500" />
            Life Balance
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {lifeBalance.map((item) => (
              <div
                key={item.domain}
                className={`rounded-lg border px-3 py-2.5 ${STATUS_BG[item.status]}`}
              >
                <div className="flex items-center gap-2">
                  <div className={`h-2 w-2 rounded-full ${STATUS_DOT[item.status]}`} />
                  <span className="text-xs font-medium">{item.domain}</span>
                </div>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {item.lastActivityDays === null
                    ? 'No activity'
                    : item.lastActivityDays === 0
                      ? 'Active today'
                      : `${item.lastActivityDays}d ago`}
                </p>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {/* ── Suggested Priorities ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ListOrdered className="h-4 w-4 text-indigo-500" />
            Suggested Priorities
          </CardTitle>
        </CardHeader>
        <CardContent>
          {suggestedPriorities.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No tasks to prioritise right now.
            </p>
          ) : (
            <div className="space-y-2">
              {suggestedPriorities.map((item, i) => (
                <button
                  key={item.id}
                  onClick={() => onNavigate?.(item)}
                  className="flex items-center gap-3 w-full rounded-lg border bg-muted/30 px-3 py-2 text-left hover:bg-muted/50 transition-colors cursor-pointer"
                >
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/10 text-[10px] font-bold text-primary shrink-0">
                    {i + 1}
                  </span>
                  <span className="text-sm truncate flex-1">{item.title}</span>
                  <Badge variant={PRIORITY_VARIANT[item.priority] ?? 'outline'} className="text-[10px] px-1.5 py-0">
                    {item.priority}
                  </Badge>
                  {item.dueDate && item.dueDate < new Date().toISOString().split('T')[0] && (
                    <Badge variant="destructive" className="text-[10px] px-1.5 py-0">
                      overdue
                    </Badge>
                  )}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/* ─── Risk Section (Collapsible) ─── */

function RiskSection({
  icon,
  label,
  items,
  onArchive,
  onNavigate,
}: {
  icon: React.ReactNode
  label: string
  items: Entity[]
  onArchive: (item: Entity) => void
  onNavigate?: (item: Entity) => void
}) {
  const [open, setOpen] = useState(false)

  if (items.length === 0) return null

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <button className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/50 transition-colors cursor-pointer">
          <ChevronRight
            className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${
              open ? 'rotate-90' : ''
            }`}
          />
          {icon}
          <span className="text-xs font-medium flex-1 text-left">{label}</span>
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
            {items.length}
          </Badge>
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-5 space-y-1 pb-1">
          {items.map((item) => (
            <div
              key={item.id}
              className="flex items-center gap-2 rounded-md px-2 py-1 text-xs"
            >
              <span className="flex-1 truncate">{item.title}</span>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[10px]"
                onClick={() => onNavigate?.(item)}
              >
                <ChevronRight className="h-3 w-3" />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 px-1.5 text-[10px] text-muted-foreground hover:text-destructive"
                onClick={() => onArchive(item)}
              >
                <Archive className="h-3 w-3" />
              </Button>
            </div>
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
