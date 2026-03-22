import { useMemo, useState, useEffect, useRef, useCallback } from 'react'
import {
  BarChart3,
  Briefcase,
  TrendingUp,
  TrendingDown,
  Minus,
  Target,
  CheckSquare,
  Repeat,
  Moon,
  Dumbbell,
  Flame,
  Brain,
  Timer,
  User,
  Zap,
  Crown,
  ChevronDown,
  Sparkles,
  Shuffle,
} from 'lucide-react'
import {
  RadarChart,
  Radar,
  PolarGrid,
  PolarAngleAxis,
  ResponsiveContainer,
  Tooltip,
} from 'recharts'
import { Card } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { useEntities, useTrackers } from '@/core/hooks'
import { useAI } from '@/hooks/use-ai'
import { calcFocusStats, formatMinutes as fmtMin } from '@/lib/focus-stats'
import { loadHealthProfile, calcBMI, getBMICategory } from '@/lib/health-calc'
import { FocusLog } from './dashboard/focus-log'
import { StrategyTab } from './dashboard/strategy-tab'
import { ForesightTab } from './dashboard/foresight-tab'
import { useDashboardLayout } from './dashboard/use-dashboard-layout'
import { DynamicGrid } from './dashboard/dynamic-grid'
import './dashboard/widgets' // triggers widget registration
import type { Entity, Tracker } from '@/core/types'

/* ─── Date helpers ─── */

function startOfWeek(date: Date): Date {
  const d = new Date(date)
  const day = d.getDay()
  d.setDate(d.getDate() - (day === 0 ? 6 : day - 1))
  d.setHours(0, 0, 0, 0)
  return d
}

function getLast90Days(): string[] {
  const days: string[] = []
  const now = new Date()
  for (let i = 89; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    days.push(d.toISOString().split('T')[0])
  }
  return days
}

/* ─── Trend arrow component ─── */

function TrendIndicator({ current, previous, suffix = '' }: {
  current: number
  previous: number
  suffix?: string
}) {
  const diff = current - previous
  if (diff === 0) {
    return (
      <span className="flex items-center gap-1 text-xs text-muted-foreground">
        <Minus className="h-3 w-3" />
        No change
      </span>
    )
  }
  const sign = diff > 0 ? '+' : ''
  return (
    <span className={`flex items-center gap-1 text-xs font-medium ${
      diff > 0 ? 'text-green-600 dark:text-green-400' : 'text-red-500 dark:text-red-400'
    }`}>
      {diff > 0 ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
      {sign}{diff}{suffix} vs last week
    </span>
  )
}

/* ─── Life Score label ─── */

function getScoreLabel(score: number): { label: string; color: string } {
  if (score >= 90) return { label: 'Excellent', color: 'text-green-600 dark:text-green-400' }
  if (score >= 75) return { label: 'Great', color: 'text-green-600 dark:text-green-400' }
  if (score >= 60) return { label: 'Good', color: 'text-blue-600 dark:text-blue-400' }
  if (score >= 40) return { label: 'Fair', color: 'text-amber-600 dark:text-amber-400' }
  return { label: 'Needs work', color: 'text-red-500 dark:text-red-400' }
}

/* ─── Metric computation helpers ─── */

function computeCheckInRate(items: Entity[], trackers: Tracker[], from: Date, to: Date): number {
  if (items.length === 0) return 0
  const fromISO = from.toISOString()
  const toISO = to.toISOString()
  const days = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86400000))
  const totalSlots = items.length * days
  const itemIds = new Set(items.map((i) => i.id))
  let checkIns = 0
  for (const t of trackers) {
    if (itemIds.has(t.entityId) && t.timestamp >= fromISO && t.timestamp < toISO) checkIns++
  }
  return Math.round((checkIns / totalSlots) * 100)
}

function computeAvgSleep(sleepEntities: Entity[], fromISO: string, toISO?: string): number {
  const filtered = sleepEntities.filter((e) => {
    const date = e.dueDate ?? e.createdAt
    return date >= fromISO && (toISO ? date < toISO : true)
  })
  if (filtered.length === 0) return 0
  const total = filtered.reduce((sum, e) => sum + (typeof e.metadata.sleepHours === 'number' ? (e.metadata.sleepHours as number) : 0), 0)
  return Math.round((total / filtered.length) * 10) / 10
}

function computeActiveMinutes(workouts: Entity[], fromISO: string, toISO?: string): number {
  return workouts
    .filter((w) => { const d = w.dueDate ?? w.createdAt; return d >= fromISO && (toISO ? d < toISO : true) })
    .reduce((sum, w) => sum + (typeof w.metadata.duration === 'number' ? (w.metadata.duration as number) : 0), 0)
}

/* ─── Section header ─── */

function SH({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-3">
      {children}
    </h2>
  )
}

/* ─── Main page ─── */

export function DashboardPage() {
  const { items: allEntities } = useEntities()
  const { items: allTrackers } = useTrackers()
  const [focusLogOpen, setFocusLogOpen] = useState(true)
  const [workspace, setWorkspace] = useState<'all' | 'work' | 'personal'>('all')
  const [dashTab, setDashTab] = useState('overview')

  // Dynamic widget layout
  const layout = useDashboardLayout()

  // Dashboard mode: rules (algorithmic) or lyra (AI-curated)
  const [dashMode, setDashMode] = useState<'rules' | 'lyra'>(() => {
    try { return (localStorage.getItem('lyra:dashboard-mode') as 'rules' | 'lyra') ?? 'rules' } catch { return 'rules' }
  })
  const handleModeChange = (mode: 'rules' | 'lyra') => {
    setDashMode(mode)
    try { localStorage.setItem('lyra:dashboard-mode', mode) } catch { /* noop */ }
    if (mode === 'lyra' && isOnline) generateAILayout()
  }

  // AI summary + AI layout
  const { run, isOnline } = useAI()
  const [aiDashSummary, setAiDashSummary] = useState<string | null>(null)
  const aiSummaryFetched = useRef(false)

  // AI-curated layout: ask Lyra for dashboard summary
  const generateAILayout = useCallback(async () => {
    if (!isOnline) return
    try {
      const response = await run('suggest-focus')
      setAiDashSummary(response)
    } catch { /* silent */ }
  }, [isOnline, run])

  useEffect(() => {
    if (!isOnline || aiSummaryFetched.current) return
    aiSummaryFetched.current = true
    run('suggest-focus')
      .then((result) => setAiDashSummary(result))
      .catch(() => {
        // fall back to algorithmic summary below
      })
  }, [isOnline, run])

  // Filter entities by workspace
  const filteredEntities = useMemo(() => {
    if (workspace === 'all') return allEntities
    return allEntities.filter((e) => e.metadata.workspace === workspace)
  }, [allEntities, workspace])

  // Filter trackers to only include those for filtered entities
  const filteredTrackers = useMemo(() => {
    if (workspace === 'all') return allTrackers
    const entityIds = new Set(filteredEntities.map((e) => e.id))
    return allTrackers.filter((t) => entityIds.has(t.entityId))
  }, [allTrackers, filteredEntities, workspace])

  const now = useMemo(() => new Date(), [])
  const thisWeekStart = useMemo(() => startOfWeek(now), [now])
  const lastWeekStart = useMemo(() => { const d = new Date(thisWeekStart); d.setDate(d.getDate() - 7); return d }, [thisWeekStart])
  const thisWeekISO = useMemo(() => thisWeekStart.toISOString(), [thisWeekStart])
  const lastWeekISO = useMemo(() => lastWeekStart.toISOString(), [lastWeekStart])

  // ─── Filtered entities by type ───
  const tasks = useMemo(() => filteredEntities.filter((e) => e.type === 'task'), [filteredEntities])
  const habits = useMemo(() => filteredEntities.filter((e) => e.type === 'habit' && e.status === 'todo' && !e.metadata.isProtocol), [filteredEntities])
  const protocols = useMemo(() => filteredEntities.filter((e) => e.type === 'habit' && e.status === 'todo' && e.metadata.isProtocol === true), [filteredEntities])
  const goals = useMemo(() => filteredEntities.filter((e) => e.type === 'goal' && e.status === 'todo'), [filteredEntities])
  const sleepEntities = useMemo(() => filteredEntities.filter((e) => e.type === 'sleep-mood'), [filteredEntities])
  const workouts = useMemo(() => filteredEntities.filter((e) => e.type === 'workout'), [filteredEntities])

  // ─── Metrics ───
  const tasksThisWeek = useMemo(() => tasks.filter((t) => t.status === 'done' && t.updatedAt >= thisWeekISO).length, [tasks, thisWeekISO])
  const tasksLastWeek = useMemo(() => tasks.filter((t) => t.status === 'done' && t.updatedAt >= lastWeekISO && t.updatedAt < thisWeekISO).length, [tasks, lastWeekISO, thisWeekISO])
  const habitRate = useMemo(() => computeCheckInRate(habits, filteredTrackers, thisWeekStart, now), [habits, filteredTrackers, thisWeekStart, now])
  const habitRateLast = useMemo(() => computeCheckInRate(habits, filteredTrackers, lastWeekStart, thisWeekStart), [habits, filteredTrackers, lastWeekStart, thisWeekStart])
  const protocolRate = useMemo(() => computeCheckInRate(protocols, filteredTrackers, thisWeekStart, now), [protocols, filteredTrackers, thisWeekStart, now])
  const avgSleepThisWeek = useMemo(() => computeAvgSleep(sleepEntities, thisWeekISO), [sleepEntities, thisWeekISO])
  const avgSleepLastWeek = useMemo(() => computeAvgSleep(sleepEntities, lastWeekISO, thisWeekISO), [sleepEntities, lastWeekISO, thisWeekISO])
  const activeMinThisWeek = useMemo(() => computeActiveMinutes(workouts, thisWeekISO), [workouts, thisWeekISO])
  const activeMinLastWeek = useMemo(() => computeActiveMinutes(workouts, lastWeekISO, thisWeekISO), [workouts, lastWeekISO, thisWeekISO])
  const goalProgressAvg = useMemo(() => {
    if (goals.length === 0) return 0
    return Math.round(goals.reduce((sum, g) => sum + (typeof g.metadata.progress === 'number' ? (g.metadata.progress as number) : 0), 0) / goals.length)
  }, [goals])

  // ─── Focus stats ───
  const entityTitles = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of filteredEntities) m.set(e.id, e.title)
    return m
  }, [filteredEntities])
  const focusStats = useMemo(() => calcFocusStats(filteredTrackers, entityTitles), [filteredTrackers, entityTitles])

  // Focus sessions for today's log
  const todaySessions = useMemo(() => {
    const todayStr = new Date().toISOString().split('T')[0]
    return filteredTrackers
      .filter((t) => t.unit === 'focus-min' && t.timestamp.startsWith(todayStr))
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .map((t) => ({
        id: t.id,
        title: entityTitles.get(t.entityId) || 'Unknown',
        minutes: t.value,
        time: new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      }))
  }, [filteredTrackers, entityTitles])

  // Focus heatmap (90 days)
  const focusHeatmapDays = useMemo(() => getLast90Days(), [])
  const focusHeatmap = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of filteredTrackers) {
      if (t.unit !== 'focus-min') continue
      const day = t.timestamp.split('T')[0]
      m.set(day, (m.get(day) ?? 0) + t.value)
    }
    return m
  }, [filteredTrackers])
  const maxFocusHeatmap = useMemo(() => {
    let max = 1
    for (const v of focusHeatmap.values()) { if (v > max) max = v }
    return max
  }, [focusHeatmap])

  // ─── Life Score ───
  const focusScoreRaw = useMemo(() => {
    // Focus score: based on 2h/day target for days elapsed
    const daysSoFar = Math.max(1, Math.ceil((now.getTime() - thisWeekStart.getTime()) / 86400000))
    const target = daysSoFar * 120 // 2h per day
    return Math.min(Math.round((focusStats.thisWeekMinutes / target) * 100), 100)
  }, [focusStats.thisWeekMinutes, now, thisWeekStart])

  const lifeScore = useMemo(() => {
    const daysSoFar = Math.max(1, Math.ceil((now.getTime() - thisWeekStart.getTime()) / 86400000))
    const taskBaseline = Math.max(tasksLastWeek, 5)
    const taskScore = Math.min(tasksThisWeek / taskBaseline, 1) * 100
    const habitScore = habitRate
    const goalScore = goalProgressAvg
    const sleepScore = avgSleepThisWeek > 0 ? Math.min(avgSleepThisWeek / 7, 1) * 100 : 50
    const targetMinutes = (150 / 7) * daysSoFar
    const activeScore = targetMinutes > 0 ? Math.min(activeMinThisWeek / targetMinutes, 1) * 100 : 50
    return Math.round(taskScore * 0.20 + habitScore * 0.25 + goalScore * 0.15 + sleepScore * 0.15 + activeScore * 0.10 + focusScoreRaw * 0.15)
  }, [tasksThisWeek, tasksLastWeek, habitRate, goalProgressAvg, avgSleepThisWeek, activeMinThisWeek, focusScoreRaw, now, thisWeekStart])

  const scoreInfo = getScoreLabel(lifeScore)

  // ─── Radar chart data (6 dimensions, 0-100) ───
  const radarData = useMemo(() => {
    const daysSoFar = Math.max(1, Math.ceil((now.getTime() - thisWeekStart.getTime()) / 86400000))
    const taskBaseline = Math.max(tasksLastWeek, 5)
    const taskScore = Math.min(Math.round((tasksThisWeek / taskBaseline) * 100), 100)
    const sleepScore = avgSleepThisWeek > 0 ? Math.min(Math.round((avgSleepThisWeek / 8) * 100), 100) : 0
    const targetMin = (150 / 7) * daysSoFar
    const activeScore = targetMin > 0 ? Math.min(Math.round((activeMinThisWeek / targetMin) * 100), 100) : 0
    return [
      { dimension: 'Tasks', value: taskScore, fullMark: 100 },
      { dimension: 'Habits', value: habitRate, fullMark: 100 },
      { dimension: 'Focus', value: focusScoreRaw, fullMark: 100 },
      { dimension: 'Goals', value: goalProgressAvg, fullMark: 100 },
      { dimension: 'Sleep', value: sleepScore, fullMark: 100 },
      { dimension: 'Activity', value: activeScore, fullMark: 100 },
    ]
  }, [tasksThisWeek, tasksLastWeek, habitRate, focusScoreRaw, goalProgressAvg, avgSleepThisWeek, activeMinThisWeek, now, thisWeekStart])

  // ─── Protocol streaks ───
  const protocolStreaks = useMemo(
    () => protocols.map((p) => ({ id: p.id, name: p.title, streak: typeof p.metadata.streak === 'number' ? (p.metadata.streak as number) : 0 })).sort((a, b) => b.streak - a.streak),
    [protocols],
  )

  // ─── Activity heatmap ───
  const heatmapDays = useMemo(() => getLast90Days(), [])
  const heatmapData = useMemo(() => {
    const allHabitIds = new Set([...habits.map((h) => h.id), ...protocols.map((p) => p.id)])
    const m = new Map<string, number>()
    for (const t of filteredTrackers) { if (allHabitIds.has(t.entityId)) { const d = t.timestamp.split('T')[0]; m.set(d, (m.get(d) ?? 0) + 1) } }
    return m
  }, [habits, protocols, filteredTrackers])
  const maxHeatmapValue = useMemo(() => { let max = 1; for (const v of heatmapData.values()) { if (v > max) max = v }; return max }, [heatmapData])
  const totalCheckIns = useMemo(() => Array.from(heatmapData.values()).reduce((a, b) => a + b, 0), [heatmapData])

  // ─── Health ───
  const healthProfile = useMemo(() => loadHealthProfile(), [])
  const latestWeight = useMemo(() => {
    const metrics = filteredEntities.filter((e) => e.type === 'body-metric' && typeof e.metadata.weight === 'number').sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    return metrics.length > 0 ? (metrics[0].metadata.weight as number) : null
  }, [filteredEntities])
  const bmiInfo = useMemo(() => {
    if (!healthProfile || !latestWeight) return null
    const bmi = calcBMI(latestWeight, healthProfile.heightCm)
    return { bmi: Math.round(bmi * 10) / 10, category: getBMICategory(bmi) }
  }, [healthProfile, latestWeight])

  // ─── AI Summary ───
  const aiSummary = useMemo(() => {
    const parts: string[] = []
    const taskDiff = tasksThisWeek - tasksLastWeek
    parts.push(`${tasksThisWeek} tasks done${tasksLastWeek > 0 ? ` (${taskDiff >= 0 ? '+' : ''}${taskDiff})` : ''}.`)
    parts.push(`Habits: ${habitRate}%. Focus: ${fmtMin(focusStats.thisWeekMinutes)} (${focusStats.streak}d streak).`)
    if (protocolRate > 0) parts.push(`Protocols: ${protocolRate}%.`)
    if (avgSleepThisWeek > 0) parts.push(`Sleep: ${avgSleepThisWeek}h avg.`)
    if (activeMinThisWeek > 0) parts.push(`Active: ${activeMinThisWeek}min.`)
    if (bmiInfo) parts.push(`BMI: ${bmiInfo.bmi} (${bmiInfo.category}).`)
    if (goalProgressAvg > 0) parts.push(`Goals: ${goalProgressAvg}%.`)
    parts.push(`Score: ${lifeScore}/100.`)
    return parts.join(' ')
  }, [tasksThisWeek, tasksLastWeek, habitRate, protocolRate, avgSleepThisWeek, activeMinThisWeek, bmiInfo, goalProgressAvg, lifeScore, focusStats])

  // ─── Trend cards ───
  const trendCards = [
    { label: 'Tasks Done', icon: CheckSquare, value: tasksThisWeek, previous: tasksLastWeek, suffix: '' },
    { label: 'Habit Rate', icon: Repeat, value: habitRate, previous: habitRateLast, suffix: '%' },
    { label: 'Focus Time', icon: Timer, value: focusStats.thisWeekMinutes, previous: focusStats.lastWeekMinutes, suffix: 'm', display: fmtMin(focusStats.thisWeekMinutes) },
    { label: 'Avg Sleep', icon: Moon, value: avgSleepThisWeek, previous: avgSleepLastWeek, suffix: 'h' },
    { label: 'Active Min', icon: Dumbbell, value: activeMinThisWeek, previous: activeMinLastWeek, suffix: '' },
    { label: 'Goal Progress', icon: Target, value: goalProgressAvg, previous: 0, suffix: '%' },
  ]

  // ─── Render ───
  return (
    <div className="h-[calc(100vh-5rem)] flex flex-col overflow-y-auto scrollbar-thin">
      <header className="shrink-0 pb-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight flex items-center gap-2">
              <BarChart3 className="h-6 w-6 text-primary/70" />
              Dashboard
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">Life metrics, focus analytics, and weekly trends</p>
          </div>
        </div>
        <Tabs value={dashTab} onValueChange={setDashTab} className="mt-3">
          <TabsList>
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="strategy">Strategy</TabsTrigger>
            <TabsTrigger value="focus">Focus Log</TabsTrigger>
            <TabsTrigger value="foresight">Foresight</TabsTrigger>
          </TabsList>
        </Tabs>
      </header>

      <Tabs value={dashTab} onValueChange={setDashTab} className="flex-1 min-h-0">

      <TabsContent value="overview" className="mt-0">

      {/* Workspace filter */}
      <div className="flex justify-end mb-4">
        <Tabs value={workspace} onValueChange={(v) => setWorkspace(v as 'all' | 'work' | 'personal')}>
          <TabsList>
            <TabsTrigger value="all" className="gap-1.5 text-xs">
              <BarChart3 className="h-3 w-3" />
              All
            </TabsTrigger>
            <TabsTrigger value="work" className="gap-1.5 text-xs">
              <Briefcase className="h-3 w-3" />
              Work
            </TabsTrigger>
            <TabsTrigger value="personal" className="gap-1.5 text-xs">
              <User className="h-3 w-3" />
              Personal
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {/* ── Dynamic Widget Grid ── */}
      {layout.selectedWidgets.length > 0 && (
        <div className="shrink-0 pb-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-primary/70" />
              Lyra&apos;s Dashboard
            </h2>
            <div className="flex items-center gap-2">
              {/* Mode toggle */}
              <div className="inline-flex items-center rounded-lg bg-muted p-0.5">
                <button
                  onClick={() => handleModeChange('rules')}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    dashMode === 'rules' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <Zap className="h-3 w-3" />
                  Rules
                </button>
                <button
                  onClick={() => handleModeChange('lyra')}
                  className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                    dashMode === 'lyra'
                      ? 'bg-background text-foreground shadow-sm'
                      : isOnline
                        ? 'text-muted-foreground hover:text-foreground'
                        : 'text-muted-foreground/30 cursor-not-allowed'
                  }`}
                  disabled={!isOnline}
                  title={!isOnline ? 'Lyra is offline — start Ollama' : 'AI-curated dashboard'}
                >
                  <Brain className="h-3 w-3" />
                  Lyra
                </button>
              </div>
              <Button variant="outline" size="sm" onClick={dashMode === 'lyra' ? generateAILayout : layout.shuffle} className="gap-1.5">
                <Shuffle className="h-3.5 w-3.5" />
                {dashMode === 'lyra' ? 'Regenerate' : 'Shuffle'}
              </Button>
            </div>
          </div>
          {dashMode === 'lyra' && aiDashSummary ? (
            <p className="text-sm text-foreground/80 leading-relaxed line-clamp-2 bg-primary/5 rounded-md px-3 py-2 border border-primary/10">
              <Sparkles className="h-3 w-3 text-primary inline mr-1.5 -mt-0.5" />
              {aiDashSummary}
            </p>
          ) : (
            <p className="text-xs text-muted-foreground">
              {dashMode === 'rules' ? 'Rules mode' : 'Lyra mode'} · {layout.selectedWidgets.length} widgets active
            </p>
          )}
          <DynamicGrid
            widgets={layout.selectedWidgets}
            entities={allEntities}
            trackers={allTrackers}
            onPin={(id) =>
              layout.pinnedIds.includes(id)
                ? layout.unpinWidget(id)
                : layout.pinWidget(id)
            }
            onHide={layout.hideWidget}
            pinnedIds={layout.pinnedIds}
          />
          <Separator className="mt-4" />
        </div>
      )}

      <div className="space-y-6 pb-8">

        {/* ── Row 1: Life Score + Radar Chart ── */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Life Score */}
          <Card className="p-6 flex items-center">
            <div className="flex items-center gap-6 w-full">
              <div className="relative shrink-0">
                <svg className="h-28 w-28 -rotate-90" viewBox="0 0 100 100">
                  <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="7" className="text-muted/30" />
                  <circle cx="50" cy="50" r="42" fill="none" stroke="currentColor" strokeWidth="7" strokeLinecap="round" strokeDasharray={`${lifeScore * 2.64} 264`} className={scoreInfo.color} />
                </svg>
                <div className="absolute inset-0 flex items-center justify-center">
                  <span className="text-3xl font-bold tabular-nums">{lifeScore}</span>
                </div>
              </div>
              <div>
                <h2 className="text-lg font-semibold">Life Score</h2>
                <Badge variant="secondary" className={`mt-1 ${scoreInfo.color}`}>{scoreInfo.label}</Badge>
                <p className="text-xs text-muted-foreground mt-3 max-w-xs leading-relaxed">
                  Tasks 20% · Habits 25% · Focus 15% · Goals 15% · Sleep 15% · Activity 10%
                </p>
              </div>
            </div>
          </Card>

          {/* Radar Chart */}
          <Card className="p-5 flex flex-col">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70 mb-2">Life Balance</p>
            <div className="flex-1 min-h-0">
              <ResponsiveContainer width="100%" height="100%" minHeight={180}>
                <RadarChart data={radarData} cx="50%" cy="50%" outerRadius="68%">
                  <PolarGrid stroke="#a1a1aa" strokeOpacity={0.2} gridType="polygon" />
                  <PolarAngleAxis
                    dataKey="dimension"
                    tick={{ fontSize: 12, fill: '#d4d4d8', fontWeight: 500 }}
                    tickLine={false}
                    dy={2}
                  />
                  <Radar
                    dataKey="value"
                    stroke="#22c55e"
                    fill="#22c55e"
                    fillOpacity={0.12}
                    strokeWidth={2}
                    dot={{ r: 3, fill: '#22c55e', strokeWidth: 0 }}
                  />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: 'hsl(var(--card))',
                      border: '1px solid hsl(var(--border))',
                      borderRadius: '8px',
                      fontSize: '12px',
                      padding: '6px 10px',
                    }}
                    formatter={(value: number | undefined) => [`${value ?? 0}%`, 'Score']}
                  />
              </RadarChart>
            </ResponsiveContainer>
            </div>
          </Card>
        </div>

        {/* ── Row 2: Weekly Trends ── */}
        <div>
          <SH>Weekly Trends</SH>
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {trendCards.map((card) => {
              const Icon = card.icon
              return (
                <Card key={card.label} className="p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Icon className="h-4 w-4 text-muted-foreground/60" />
                    <span className="text-xs text-muted-foreground font-medium">{card.label}</span>
                  </div>
                  <p className="text-2xl font-bold tabular-nums">
                    {'display' in card ? card.display : `${card.value}${card.suffix}`}
                  </p>
                  <div className="mt-1.5">
                    <TrendIndicator current={card.value} previous={card.previous} suffix={card.suffix} />
                  </div>
                </Card>
              )
            })}
          </div>
        </div>

        {/* ── Row 3: Focus Analytics ── */}
        <div>
          <SH>
            <Crown className="h-3 w-3 inline mr-1.5 -mt-px text-amber-500" />
            Focus Analytics
          </SH>
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Focus stats cards */}
            <Card className="p-4 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                {[
                  { label: 'Today', value: fmtMin(focusStats.todayMinutes), sub: `${focusStats.todaySessions} sessions`, icon: Timer },
                  { label: 'Streak', value: `${focusStats.streak}d`, sub: 'consecutive', icon: Zap },
                  { label: 'This Week', value: fmtMin(focusStats.thisWeekMinutes), sub: focusStats.weekDiff >= 0 ? `+${fmtMin(focusStats.weekDiff)}` : `${fmtMin(Math.abs(focusStats.weekDiff))}`, icon: TrendingUp },
                  { label: 'Sessions', value: `${focusStats.todaySessions}`, sub: 'today', icon: Flame },
                ].map((stat) => (
                  <div key={stat.label} className="bg-muted/30 rounded-lg p-3">
                    <div className="flex items-center gap-1.5 mb-1">
                      <stat.icon className="h-3 w-3 text-muted-foreground/50" />
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground/60">{stat.label}</span>
                    </div>
                    <p className="text-lg font-semibold tabular-nums">{stat.value}</p>
                    <p className="text-[10px] text-muted-foreground/50 tabular-nums">{stat.sub}</p>
                  </div>
                ))}
              </div>
            </Card>

            {/* Weekly focus chart */}
            <Card className="p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-3">Weekly Focus</p>
              <div className="flex items-end gap-2 h-28">
                {focusStats.weekDays.map((day) => {
                  const maxMin = Math.max(...focusStats.weekDays.map((d) => d.minutes), 1)
                  const h = day.minutes > 0 ? Math.max((day.minutes / maxMin) * 100, 6) : 0
                  const isToday = day.date === new Date().toISOString().split('T')[0]
                  return (
                    <div key={day.date} className="flex-1 flex flex-col items-center gap-1.5">
                      <div className="w-full flex items-end justify-center" style={{ height: '80px' }}>
                        {day.minutes > 0 ? (
                          <div
                            className={`w-full max-w-[24px] rounded-t transition-all ${isToday ? 'bg-amber-500' : 'bg-primary/30'}`}
                            style={{ height: `${h}%` }}
                            title={`${fmtMin(day.minutes)} · ${day.sessions} sessions`}
                          />
                        ) : (
                          <div className="w-full max-w-[24px] h-[2px] rounded-full bg-muted" />
                        )}
                      </div>
                      <span className={`text-[9px] font-medium tabular-nums ${isToday ? 'text-amber-500' : 'text-muted-foreground/50'}`}>
                        {day.label}
                      </span>
                      {day.minutes > 0 && (
                        <span className="text-[8px] text-muted-foreground/40 tabular-nums -mt-1">{fmtMin(day.minutes)}</span>
                      )}
                    </div>
                  )
                })}
              </div>
            </Card>

            {/* Top tasks */}
            <Card className="p-4">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-3">Top Focus Tasks</p>
              <div className="space-y-2.5">
                {focusStats.topTasks.length === 0 ? (
                  <p className="text-xs text-muted-foreground/40 py-4 text-center">No focus sessions yet</p>
                ) : focusStats.topTasks.map((task, i) => {
                  const maxMin = focusStats.topTasks[0]?.minutes ?? 1
                  const pct = (task.minutes / maxMin) * 100
                  return (
                    <div key={task.entityId} className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-muted-foreground/40 w-3 tabular-nums">{i + 1}</span>
                        <span className="text-xs truncate flex-1">{task.title}</span>
                        <span className="text-[10px] text-muted-foreground tabular-nums font-medium">{fmtMin(task.minutes)}</span>
                      </div>
                      <div className="ml-5 h-1 rounded-full bg-muted overflow-hidden">
                        <div className="h-full rounded-full bg-amber-500/50" style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )
                })}
              </div>
            </Card>
          </div>
        </div>

        {/* ── Row 5: Focus Heatmap + Today's Sessions ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Focus Heatmap */}
          <Card className="p-4 lg:col-span-2">
            <div className="flex items-center justify-between mb-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60">Focus Heatmap — 90 Days</p>
              <span className="text-[10px] text-muted-foreground tabular-nums">{fmtMin(Array.from(focusHeatmap.values()).reduce((a, b) => a + b, 0))} total</span>
            </div>
            <div className="flex flex-wrap gap-[2px]">
              {focusHeatmapDays.map((day) => {
                const minutes = focusHeatmap.get(day) ?? 0
                const intensity = minutes === 0 ? 0 : Math.ceil((minutes / maxFocusHeatmap) * 4)
                return (
                  <div
                    key={day}
                    title={`${day}: ${fmtMin(minutes)}`}
                    className={`w-2.5 h-2.5 rounded-sm ${
                      intensity === 0 ? 'bg-muted' :
                      intensity === 1 ? 'bg-amber-200 dark:bg-amber-900/60' :
                      intensity === 2 ? 'bg-amber-400 dark:bg-amber-700/70' :
                      intensity === 3 ? 'bg-amber-500 dark:bg-amber-500/80' :
                      'bg-amber-600 dark:bg-amber-400'
                    }`}
                  />
                )
              })}
            </div>
            <div className="flex items-center gap-1 mt-2 justify-end">
              <span className="text-[10px] text-muted-foreground mr-1">Less</span>
              <div className="w-2.5 h-2.5 rounded-sm bg-muted" />
              <div className="w-2.5 h-2.5 rounded-sm bg-amber-200 dark:bg-amber-900/60" />
              <div className="w-2.5 h-2.5 rounded-sm bg-amber-400 dark:bg-amber-700/70" />
              <div className="w-2.5 h-2.5 rounded-sm bg-amber-500 dark:bg-amber-500/80" />
              <div className="w-2.5 h-2.5 rounded-sm bg-amber-600 dark:bg-amber-400" />
              <span className="text-[10px] text-muted-foreground ml-1">More</span>
            </div>
          </Card>

          {/* Today's Sessions */}
          <Card className="p-4">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-3">Today&apos;s Sessions</p>
            <div className="space-y-1.5 max-h-40 overflow-y-auto">
              {todaySessions.length === 0 ? (
                <p className="text-xs text-muted-foreground/40 py-4 text-center">No sessions yet</p>
              ) : todaySessions.map((s) => (
                <div key={s.id} className="flex items-center gap-2 py-1 px-2 rounded-md bg-muted/20">
                  <span className="text-[10px] text-muted-foreground/50 tabular-nums shrink-0">{s.time}</span>
                  <span className="text-xs truncate flex-1">{s.title}</span>
                  <span className="text-[10px] text-muted-foreground font-medium tabular-nums shrink-0">{s.minutes}m</span>
                </div>
              ))}
            </div>
          </Card>
        </div>

        {/* ── Row 6: Protocol Streaks ── */}
        {protocolStreaks.length > 0 && (
          <div>
            <SH>Protocol Streaks</SH>
            <Card className="p-4 space-y-3">
              {protocolStreaks.map((p) => (
                <div key={p.id} className="flex items-center gap-3">
                  <span className="text-sm w-36 shrink-0 truncate">{p.name}</span>
                  <div className="flex-1">
                    <Progress value={Math.min((p.streak / 30) * 100, 100)} className="h-2" />
                  </div>
                  <span className="text-sm font-medium tabular-nums w-12 text-right">{p.streak}d</span>
                </div>
              ))}
            </Card>
          </div>
        )}

        {/* ── Row 6: Activity Heatmap ── */}
        <div>
          <SH>Activity Heatmap — 90 Days</SH>
          <Card className="p-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-muted-foreground">Habits + Protocols per day</span>
              <span className="text-xs font-medium tabular-nums">{totalCheckIns} check-ins</span>
            </div>
            <div className="flex flex-wrap gap-[2px]">
              {heatmapDays.map((day) => {
                const count = heatmapData.get(day) ?? 0
                const intensity = count === 0 ? 0 : Math.ceil((count / maxHeatmapValue) * 4)
                return (
                  <div
                    key={day}
                    title={`${day}: ${count} check-in${count !== 1 ? 's' : ''}`}
                    className={`w-2.5 h-2.5 rounded-sm ${
                      intensity === 0 ? 'bg-muted' :
                      intensity === 1 ? 'bg-green-200 dark:bg-green-900' :
                      intensity === 2 ? 'bg-green-400 dark:bg-green-700' :
                      intensity === 3 ? 'bg-green-500 dark:bg-green-500' :
                      'bg-green-600 dark:bg-green-400'
                    }`}
                  />
                )
              })}
            </div>
            <div className="flex items-center gap-1 mt-2 justify-end">
              <span className="text-[10px] text-muted-foreground mr-1">Less</span>
              <div className="w-2.5 h-2.5 rounded-sm bg-muted" />
              <div className="w-2.5 h-2.5 rounded-sm bg-green-200 dark:bg-green-900" />
              <div className="w-2.5 h-2.5 rounded-sm bg-green-400 dark:bg-green-700" />
              <div className="w-2.5 h-2.5 rounded-sm bg-green-500 dark:bg-green-500" />
              <div className="w-2.5 h-2.5 rounded-sm bg-green-600 dark:bg-green-400" />
              <span className="text-[10px] text-muted-foreground ml-1">More</span>
            </div>
          </Card>
        </div>

        {/* ── Row 7: AI Context Summary ── */}
        <div>
          <SH><Brain className="h-3 w-3 inline mr-1.5 -mt-px" />AI Context Summary</SH>
          <Card className="p-4 bg-muted/30 border-dashed">
            <p className="text-sm text-muted-foreground leading-relaxed">{aiSummary}</p>
            <p className="text-[10px] text-muted-foreground/50 mt-2">Data context preview for AI assistant.</p>
          </Card>
        </div>
      </div>

      </TabsContent>

      <TabsContent value="strategy" className="mt-0 pb-8">
        <StrategyTab />
      </TabsContent>

      <TabsContent value="focus" className="mt-0 pb-8">
        <div>
          <button
            onClick={() => setFocusLogOpen(!focusLogOpen)}
            className="flex items-center gap-2 mb-3 group"
          >
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              <Crown className="h-3 w-3 inline mr-1.5 -mt-px text-amber-500" />
              Focus Log &amp; Review
            </h2>
            <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground/40 transition-transform ${focusLogOpen ? '' : '-rotate-90'}`} />
          </button>
          {focusLogOpen && <FocusLog />}
        </div>
      </TabsContent>

      <TabsContent value="foresight" className="mt-0 pb-8">
        <ForesightTab />
      </TabsContent>

      </Tabs>
    </div>
  )
}
