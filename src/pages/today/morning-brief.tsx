import { useState } from 'react'
import { useNavigate } from 'react-router'
import {
  AlertTriangle,
  TrendingDown,
  Flame,
  Lightbulb,
  Trophy,
  Info,
  ChevronDown,
  ChevronRight,
  Shield,
  Target,
  Lock,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { useMorningBrief } from '@/hooks/use-morning-brief'
import type { InsightType } from '@/hooks/brief-detectors/types'
import type { CascadeNode } from '@/pages/command-center/use-command-center'

/* ─── Icon & color maps ─── */

const typeIcons: Record<InsightType, typeof AlertTriangle> = {
  warning: AlertTriangle,
  risk: TrendingDown,
  streak: Flame,
  suggestion: Lightbulb,
  achievement: Trophy,
  info: Info,
}

const typeColors: Record<InsightType, string> = {
  warning: 'text-amber-500',
  risk: 'text-red-500',
  streak: 'text-orange-500',
  suggestion: 'text-blue-500',
  achievement: 'text-emerald-500',
  info: 'text-muted-foreground',
}

const severityDot: Record<number, string> = {
  3: 'bg-red-500',
  2: 'bg-amber-500',
  1: 'bg-blue-500',
}

/* ─── Goal Cascade Row ─── */

function CascadeRow({ node, topBlockedId, depth = 0 }: { node: CascadeNode; topBlockedId: string | null; depth?: number }) {
  const [open, setOpen] = useState(depth < 1)
  const navigate = useNavigate()
  const hasKids = node.subGoals.length > 0 || node.linkedTasks.length > 0
  const isTop = node.goal.id === topBlockedId
  return (
    <div className={depth > 0 ? 'ml-4 border-l border-border/40 pl-3' : ''}>
      <div className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-sm hover:bg-muted/40 transition-colors ${isTop ? 'bg-red-500/5' : ''}`}>
        <button onClick={() => setOpen(!open)} className="shrink-0 text-muted-foreground/50">
          {hasKids ? (open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />) : <span className="inline-block h-3 w-3" />}
        </button>
        <button onClick={() => navigate(`/goals?id=${node.goal.id}`)} className="truncate flex-1 text-left hover:underline text-xs">
          {node.goal.title}
        </button>
        {isTop && <Badge variant="destructive" className="text-[8px] px-1 py-0 leading-tight">BOTTLENECK</Badge>}
        {node.isBlocked && <Lock className="h-3 w-3 text-red-500 shrink-0" />}
        {node.isStale && <AlertTriangle className="h-3 w-3 text-amber-500 shrink-0" />}
        <Progress value={node.progress} className="h-1 w-12 shrink-0" />
        <span className="text-[10px] tabular-nums text-muted-foreground w-6 text-right shrink-0">{node.progress}%</span>
      </div>
      {open && (
        <>
          {node.subGoals.map((sg) => <CascadeRow key={sg.goal.id} node={sg} topBlockedId={topBlockedId} depth={depth + 1} />)}
          {node.linkedTasks.map((t) => (
            <div key={t.id} className="ml-4 border-l border-border/30 pl-3">
              <button onClick={() => navigate(`/tasks?id=${t.id}`)} className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors w-full text-left">
                <span className="h-1 w-1 rounded-full bg-blue-500/60 shrink-0" />
                <span className="truncate">{t.title}</span>
              </button>
            </div>
          ))}
        </>
      )}
    </div>
  )
}

/* ─── Main Component ─── */

interface MorningBriefProps {
  cascadeTree: CascadeNode[]
  topBlockedGoal: CascadeNode | null
  stats: { totalGoals: number; totalTasks: number; blockedGoals: number; staleGoals: number }
}

export function MorningBrief({ cascadeTree, topBlockedGoal, stats }: MorningBriefProps) {
  const insights = useMorningBrief()
  const navigate = useNavigate()

  const [briefOpen, setBriefOpen] = useState(true)
  const [cascadeOpen, setCascadeOpen] = useState(false)

  const criticalCount = insights.filter((i) => i.severity >= 2).length
  const hasInsights = insights.length > 0
  const hasCascade = cascadeTree.length > 0

  if (!hasInsights && !hasCascade) return null

  return (
    <div className="rounded-lg border bg-card/50 overflow-hidden">
      {/* ─── Brief Section ─── */}
      {hasInsights && (
        <>
          <button
            onClick={() => setBriefOpen(!briefOpen)}
            className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-muted/30 transition-colors"
          >
            <Shield className="h-3.5 w-3.5 text-primary shrink-0" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">
              Brief
            </span>
            {criticalCount > 0 && (
              <span className="flex items-center justify-center h-4 min-w-4 px-1 rounded-full bg-red-500/10 text-red-500 text-[10px] font-bold">
                {criticalCount}
              </span>
            )}
            <span className="text-[10px] text-muted-foreground/50">{insights.length}</span>
            {briefOpen ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground/40" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
            )}
          </button>

          {briefOpen && (
            <div className="px-1 pb-1 space-y-0.5">
              {insights.map((insight) => {
                const Icon = typeIcons[insight.type] ?? Info
                return (
                  <div
                    key={insight.id}
                    className={`flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors ${
                      insight.actionPath ? 'hover:bg-muted/40 cursor-pointer' : ''
                    }`}
                    onClick={() => insight.actionPath && navigate(insight.actionPath)}
                    role={insight.actionPath ? 'button' : undefined}
                  >
                    <span className={`h-1.5 w-1.5 rounded-full mt-1.5 shrink-0 ${severityDot[insight.severity] ?? severityDot[1]}`} />
                    <Icon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${typeColors[insight.type]}`} />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs leading-snug">{insight.title}</p>
                      {insight.detail && (
                        <p className="text-[10px] text-muted-foreground truncate mt-0.5">{insight.detail}</p>
                      )}
                    </div>
                    {insight.actionLabel && (
                      <span className="text-[10px] text-primary shrink-0 mt-0.5">{insight.actionLabel} →</span>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </>
      )}

      {/* ─── Goal Cascade Section ─── */}
      {hasCascade && (
        <>
          {hasInsights && <div className="border-t" />}
          <button
            onClick={() => setCascadeOpen(!cascadeOpen)}
            className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-muted/30 transition-colors"
          >
            <Target className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex-1">
              Goals
            </span>
            {stats.blockedGoals > 0 && (
              <span className="text-[10px] text-red-500 font-medium">{stats.blockedGoals} blocked</span>
            )}
            {stats.staleGoals > 0 && (
              <span className="text-[10px] text-amber-500 font-medium">{stats.staleGoals} stale</span>
            )}
            <span className="text-[10px] text-muted-foreground/50">{stats.totalGoals}</span>
            {cascadeOpen ? (
              <ChevronDown className="h-3 w-3 text-muted-foreground/40" />
            ) : (
              <ChevronRight className="h-3 w-3 text-muted-foreground/40" />
            )}
          </button>

          {cascadeOpen && (
            <div className="px-1 pb-2 space-y-0.5">
              {cascadeTree.map((node) => (
                <CascadeRow key={node.goal.id} node={node} topBlockedId={topBlockedGoal?.goal.id ?? null} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
