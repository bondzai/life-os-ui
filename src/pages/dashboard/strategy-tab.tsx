import { useState, useCallback, useMemo } from 'react'
import { Sparkles, TrendingUp, TrendingDown, Minus, Wifi, WifiOff } from 'lucide-react'
import { LyraLoader } from '@/components/lyra-loader'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Separator } from '@/components/ui/separator'
import { Markdown } from '@/core/components/markdown'
import { useAI } from '@/hooks/use-ai'
import { useEntities, useTrackers } from '@/core/hooks'
import { useStrategicMoves, type StrategicMove } from '@/hooks/use-strategic-moves'
import { webSearch, formatSearchResults } from '@/core/ai/web-search'
import { AIClient } from '@/core/ai/ai-client'
import { useAIStore } from '@/stores/ai-store'
import { getSolPrefix } from '@/core/ai/sol'
import { buildGlobalContext } from '@/core/ai/context'

/* ─── Constants ─── */

const MOVE_TYPE_STYLES: Record<StrategicMove['type'], string> = {
  commit: 'bg-blue-500/10 text-blue-600 border-blue-500/30',
  pivot: 'bg-amber-500/10 text-amber-600 border-amber-500/30',
  park: 'bg-gray-500/10 text-gray-600 border-gray-500/30',
  'double-down': 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30',
  explore: 'bg-purple-500/10 text-purple-600 border-purple-500/30',
  connect: 'bg-cyan-500/10 text-cyan-600 border-cyan-500/30',
  decide: 'bg-red-500/10 text-red-600 border-red-500/30',
}

const MOVE_BORDER_COLORS: Record<StrategicMove['type'], string> = {
  commit: 'border-l-blue-500',
  pivot: 'border-l-amber-500',
  park: 'border-l-gray-500',
  'double-down': 'border-l-emerald-500',
  explore: 'border-l-purple-500',
  connect: 'border-l-cyan-500',
  decide: 'border-l-red-500',
}

const SCOPES = ['Week', 'Month', 'Quarter'] as const

const SESSION_KEY = 'lyra:strategic-moves-cache'

/* ─── Parse AI response into moves ─── */

function parseMoves(raw: string): StrategicMove[] {
  const moveBlocks = raw.split(/###\s+\[/).filter(Boolean)
  const moves: StrategicMove[] = []

  for (const block of moveBlocks) {
    const typeMatch = block.match(/^([\w-]+)\]\s*(.+)/m)
    if (!typeMatch) continue

    const rawType = typeMatch[1].toLowerCase().trim()
    const title = typeMatch[2].trim()

    const impactMatch = block.match(/Impact:\s*(high|medium)/i)
    const effortMatch = block.match(/Effort:\s*(low|medium|high)/i)
    const timeframeMatch = block.match(/Timeframe:\s*(.+?)(\n|$)/i)

    // Extract tags from "Tags: #tag1 #tag2" line
    const tagMatch = block.match(/Tags:\s*((?:#\w+\s*)+)/i)
    const tags = tagMatch ? tagMatch[1].match(/#\w+/g)?.map(t => t.slice(1)) ?? [] : []

    // Everything after the metadata line is reasoning
    const metaEnd = block.indexOf('\n', block.indexOf(impactMatch?.[0] ?? title) + 1)
    const reasoning = block
      .slice(metaEnd >= 0 ? metaEnd : 0)
      .trim()
      .replace(/^[-|]\s*/gm, '')

    const type = (
      ['commit', 'pivot', 'park', 'double-down', 'explore', 'connect', 'decide'].includes(rawType)
        ? rawType
        : 'commit'
    ) as StrategicMove['type']

    moves.push({
      id: crypto.randomUUID(),
      type,
      title,
      reasoning: reasoning || 'No additional reasoning provided.',
      impact: (impactMatch?.[1]?.toLowerCase() as 'high' | 'medium') ?? 'medium',
      effort: (effortMatch?.[1]?.toLowerCase() as 'low' | 'medium' | 'high') ?? 'medium',
      timeframe: timeframeMatch?.[1]?.trim() ?? 'this week',
      tags,
      status: 'suggested',
      createdAt: new Date().toISOString(),
    })
  }

  return moves.slice(0, 3)
}

function getCachedForToday(): { moves: StrategicMove[]; webContext?: string } | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const { date, moves, webContext } = JSON.parse(raw)
    if (date === new Date().toISOString().split('T')[0]) return { moves, webContext }
    return null
  } catch {
    return null
  }
}

function cacheForToday(moves: StrategicMove[], webContext?: string) {
  sessionStorage.setItem(
    SESSION_KEY,
    JSON.stringify({ date: new Date().toISOString().split('T')[0], moves, webContext }),
  )
}

/* ─── Section Header ─── */

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-3">
      {children}
    </h3>
  )
}

/* ─── Move Card ─── */

function MoveCard({
  move,
  onAccept,
  onPass,
}: {
  move: StrategicMove
  onAccept: () => void
  onPass: () => void
}) {
  return (
    <Card
      className={`rounded-lg border bg-card/50 border-l-4 ${MOVE_BORDER_COLORS[move.type]} p-4 space-y-2`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        <Badge variant="outline" className={MOVE_TYPE_STYLES[move.type]}>
          {move.type.toUpperCase()}
        </Badge>
        <Badge variant={move.impact === 'high' ? 'destructive' : 'secondary'}>
          {move.impact} impact
        </Badge>
        <Badge
          variant="outline"
          className={
            move.effort === 'low'
              ? 'border-green-500 text-green-600'
              : move.effort === 'medium'
                ? 'border-amber-500 text-amber-600'
                : 'border-red-500 text-red-600'
          }
        >
          {move.effort} effort
        </Badge>
        <span className="text-[10px] text-muted-foreground ml-auto">{move.timeframe}</span>
      </div>
      {move.tags && move.tags.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {move.tags.map(tag => (
            <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded-full bg-secondary text-secondary-foreground font-medium">
              #{tag}
            </span>
          ))}
        </div>
      )}
      <p className="text-sm font-semibold">{move.title}</p>
      <div className="text-xs text-muted-foreground">
        <Markdown content={move.reasoning} className="text-xs" />
      </div>
      {move.status === 'suggested' && (
        <div className="flex gap-2 pt-1">
          <Button size="sm" variant="default" onClick={onAccept}>
            Accept
          </Button>
          <Button size="sm" variant="ghost" onClick={onPass}>
            Pass
          </Button>
        </div>
      )}
    </Card>
  )
}

/* ─── Trend Arrow ─── */

function TrendArrow({ current, previous }: { current: number; previous: number }) {
  if (current > previous)
    return <TrendingUp className="h-3 w-3 text-emerald-500 inline-block ml-1" />
  if (current < previous)
    return <TrendingDown className="h-3 w-3 text-red-500 inline-block ml-1" />
  return <Minus className="h-3 w-3 text-muted-foreground inline-block ml-1" />
}

/* ─── Strategy Tab Component ─── */

export function StrategyTab() {
  const { isOnline } = useAI()
  const { items: entities } = useEntities()
  const { items: trackers } = useTrackers()
  const { suggested, setMoves, acceptMove, passMove } = useStrategicMoves()
  const [loading, setLoading] = useState(false)
  const [scope, setScope] = useState<(typeof SCOPES)[number]>('Week')
  const [externalSignals, setExternalSignals] = useState<string | null>(null)

  // Initialize from cache
  const [initialized, setInitialized] = useState(false)
  if (!initialized) {
    const cached = getCachedForToday()
    if (cached && suggested.length === 0) {
      setMoves(cached.moves)
      if (cached.webContext) setExternalSignals(cached.webContext)
    }
    setInitialized(true)
  }

  const today = useMemo(() => new Date().toISOString().split('T')[0], [])

  const generateMoves = useCallback(async () => {
    setLoading(true)
    try {
      // 1. Extract search keywords from projects/goals
      const projects = entities.filter(e => e.type === 'project' && e.status === 'in-progress')
      const goals = entities.filter(e => e.type === 'goal' && e.status !== 'done' && e.status !== 'archived')

      const searchTerms: string[] = []
      for (const p of projects.slice(0, 3)) {
        const stack = Array.isArray(p.metadata?.stack) ? (p.metadata.stack as string[]) : []
        if (stack.length > 0) searchTerms.push(`${stack[0]} trends 2026`)
        else searchTerms.push(`${p.title} latest developments`)
      }
      for (const g of goals.slice(0, 2)) {
        searchTerms.push(`${g.title} best practices`)
      }

      // 2. Search web for each term (parallel, limit to 3 searches)
      let webContext = ''
      try {
        const searchPromises = searchTerms.slice(0, 3).map(q => webSearch(q))
        const allResults = await Promise.all(searchPromises)
        webContext = allResults.map((results, i) => {
          if (results.length === 0) return ''
          return `### Search: "${searchTerms[i]}"\n${formatSearchResults(results.slice(0, 3))}`
        }).filter(Boolean).join('\n\n')
      } catch {
        // Web search failed — continue with internal data only
      }

      // 3. Get vision from store
      const vision = useAIStore.getState().vision

      // 4. Build global context
      const globalCtx = buildGlobalContext(entities, trackers)

      // 5. Build knowledge signals inline
      const notes = entities.filter(e => e.type === 'note' && !e.metadata?.isInbox && e.status !== 'archived')
      const ideas = notes.filter(n => n.tags.some(t => ['idea', 'spark'].includes(t)))
      const unactioned = ideas.filter(i => i.status === 'todo')
      const questions = notes.filter(n => n.tags.includes('question') && n.status !== 'done')
      const tagCounts: Record<string, number> = {}
      for (const n of notes) for (const t of n.tags) tagCounts[t] = (tagCounts[t] || 0) + 1
      const topTags = Object.entries(tagCounts).sort(([,a],[,b]) => b - a).slice(0, 10)

      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString()
      const projectSummaries = projects.map(p => {
        const tasks = entities.filter(e => e.type === 'task' && e.metadata?.projectId === p.id && e.status !== 'archived')
        const doneThisWeek = tasks.filter(t => t.status === 'done' && t.updatedAt >= weekAgo).length
        const remaining = tasks.filter(t => t.status !== 'done').length
        return `- ${p.title} [${p.status}]: ${doneThisWeek}/wk, ${remaining} remaining`
      }).join('\n')

      // 6. Build full prompt
      const messages = [
        {
          role: 'system' as const,
          content: [
            getSolPrefix(500),
            '',
            vision ? `\nUser's Vision: ${vision}\nAlign all recommendations with this vision.\n` : '',
            'You are performing a strategic analysis with access to BOTH internal data AND web intelligence.',
            'Generate exactly 3 high-impact strategic moves.',
            '',
            'Move types: COMMIT, PIVOT, PARK, DOUBLE-DOWN, EXPLORE, CONNECT, DECIDE',
            '',
            'IMPORTANT: Each move MUST include 1-3 tags prefixed with #.',
            'Tags should be strategic categories like: #growth, #focus, #technical, #health, #wealth, #learning, #efficiency, #risk, #innovation, #momentum',
            '',
            'Format each move as:',
            '### [TYPE] Title',
            'Tags: #tag1 #tag2',
            'Impact: high/medium | Effort: low/medium/high | Timeframe: this week/month/quarter',
            'Reasoning with specific data references. If using web intelligence, cite [source].',
            '',
            '## Internal Data:',
            globalCtx,
            '',
            `Top themes: ${topTags.map(([t,c]) => `${t}(${c})`).join(', ')}`,
            `Unactioned ideas: ${unactioned.length}`,
            `Open questions: ${questions.length}`,
            '',
            '## Projects:',
            projectSummaries,
            '',
            '## Goals:',
            goals.map(g => `- ${g.title} [${g.priority}] ${typeof g.metadata?.progress === 'number' ? g.metadata.progress : 0}%${g.dueDate ? ` due:${g.dueDate}` : ''}`).join('\n'),
            '',
            webContext ? `## Web Intelligence:\n${webContext}` : '',
          ].filter(Boolean).join('\n'),
        },
        { role: 'user' as const, content: 'What are my 3 highest-impact strategic moves right now? Consider both internal data and external trends.' },
      ]

      // 7. Call AI
      const FALLBACK = { provider: 'ollama' as const, endpoint: 'http://localhost:11434/v1', model: 'qwen3:4b', apiKey: '', contextWindow: 8192 }
      const storeConfig = useAIStore.getState().config
      const config = storeConfig.endpoint && storeConfig.model ? storeConfig : FALLBACK
      const client = new AIClient(config)
      const response = await client.complete(messages)

      // 8. Parse and store
      const moves = parseMoves(response)
      if (moves.length > 0) {
        setMoves(moves)
        cacheForToday(moves, webContext || undefined)
      }

      // Store web context for display
      setExternalSignals(webContext || null)
    } catch (err) {
      console.error('Strategy generation failed:', err)
    } finally {
      setLoading(false)
    }
  }, [entities, trackers, setMoves, today, isOnline])

  /* ─── Knowledge Pulse data ─── */

  const knowledgePulse = useMemo(() => {
    const now = Date.now()
    const notes = entities.filter(
      (e) => e.type === 'note' && !e.metadata?.isInbox && e.status !== 'archived',
    )

    // Tag counts
    const tagCounts: Record<string, number> = {}
    for (const n of notes) for (const t of n.tags) tagCounts[t] = (tagCounts[t] || 0) + 1
    const topThemes = Object.entries(tagCounts)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 8)

    // Unactioned ideas
    const unactionedIdeas = notes.filter(
      (n) => n.tags.some((t) => ['idea', 'spark'].includes(t)) && n.status === 'todo',
    ).length

    // Open questions
    const openQuestions = notes.filter(
      (n) => n.tags.includes('question') && n.status !== 'done',
    ).length

    // Stale notes (30+ days)
    const thirtyDaysAgo = new Date(now - 30 * 86400000).toISOString()
    const staleNotes = notes.filter((n) => n.updatedAt < thirtyDaysAgo).length

    // Thinking velocity: notes this week vs last week
    const weekStart = new Date(now - 7 * 86400000).toISOString()
    const twoWeeksAgo = new Date(now - 14 * 86400000).toISOString()
    const notesThisWeek = notes.filter((n) => n.createdAt >= weekStart).length
    const notesLastWeek = notes.filter(
      (n) => n.createdAt >= twoWeeksAgo && n.createdAt < weekStart,
    ).length

    return { topThemes, unactionedIdeas, openQuestions, staleNotes, notesThisWeek, notesLastWeek }
  }, [entities])

  /* ─── Scoreboard data ─── */

  const scoreboard = useMemo(() => {
    const now = Date.now()
    const weekStart = new Date(now - 7 * 86400000).toISOString()
    const twoWeeksAgo = new Date(now - 14 * 86400000).toISOString()
    const todayStr = new Date().toISOString().split('T')[0]
    const todayStart = todayStr + 'T00:00:00'

    // Task velocity
    const tasks = entities.filter((e) => e.type === 'task' && e.status !== 'archived')
    const doneThisWeek = tasks.filter(
      (t) => t.status === 'done' && t.updatedAt >= weekStart,
    ).length
    const doneLastWeek = tasks.filter(
      (t) => t.status === 'done' && t.updatedAt >= twoWeeksAgo && t.updatedAt < weekStart,
    ).length

    // Habits
    const habits = entities.filter((e) => e.type === 'habit' && e.status === 'todo')
    const checkedToday = habits.filter((h) =>
      trackers.some((t) => t.entityId === h.id && t.timestamp >= todayStart),
    ).length

    // Goals progress
    const goals = entities.filter(
      (e) => e.type === 'goal' && e.status !== 'done' && e.status !== 'archived',
    )
    const avgGoalProgress =
      goals.length > 0
        ? Math.round(
            goals.reduce(
              (sum, g) =>
                sum + (typeof g.metadata?.progress === 'number' ? g.metadata.progress : 0),
              0,
            ) / goals.length,
          )
        : 0

    // Projects with velocity
    const projects = entities.filter(
      (e) => e.type === 'project' && e.status === 'in-progress',
    )
    const projectVelocities = projects.map((p) => {
      const pTasks = tasks.filter((t) => t.metadata?.projectId === p.id)
      const thisWeek = pTasks.filter(
        (t) => t.status === 'done' && t.updatedAt >= weekStart,
      ).length
      const lastWeek = pTasks.filter(
        (t) => t.status === 'done' && t.updatedAt >= twoWeeksAgo && t.updatedAt < weekStart,
      ).length
      const total = pTasks.length
      const done = pTasks.filter((t) => t.status === 'done').length
      return { title: p.title, thisWeek, lastWeek, total, done }
    })

    // Health (sleep-mood)
    const sleepEntries = entities.filter(
      (e) => e.type === 'sleep-mood' && e.createdAt >= weekStart,
    )
    const avgSleep =
      sleepEntries.length > 0
        ? (
            sleepEntries.reduce(
              (sum, e) =>
                sum + (typeof e.metadata?.sleepHours === 'number' ? e.metadata.sleepHours : 0),
              0,
            ) / sleepEntries.length
          ).toFixed(1)
        : '--'

    // Wealth placeholder
    const accounts = entities.filter((e) => e.type === 'account' && e.status !== 'archived')
    const totalBalance = accounts.reduce(
      (sum, a) => sum + (typeof a.metadata?.balance === 'number' ? a.metadata.balance : 0),
      0,
    )

    return {
      velocity: { current: doneThisWeek, previous: doneLastWeek },
      focus: {
        current: tasks.filter((t) => t.status === 'in-progress').length,
        total: tasks.filter((t) => t.status !== 'done').length,
      },
      habits: { current: checkedToday, total: habits.length },
      health: { sleep: avgSleep },
      wealth: { balance: totalBalance },
      goals: { progress: avgGoalProgress, count: goals.length },
      projectVelocities,
    }
  }, [entities, trackers])

  return (
    <div className="space-y-6">
      {/* Scope selector */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          {isOnline ? (
            <Wifi className="h-4 w-4 text-emerald-500" />
          ) : (
            <WifiOff className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
        <div className="flex gap-1">
          {SCOPES.map((s) => (
            <Badge
              key={s}
              variant={scope === s ? 'default' : 'outline'}
              className="cursor-pointer"
              onClick={() => setScope(s)}
            >
              {s}
            </Badge>
          ))}
        </div>
      </div>

      {/* Section 1: Next Moves */}
      <section>
        <div className="flex items-center justify-between mb-3">
          <SectionHeader>Next Moves</SectionHeader>
          <Button size="sm" onClick={generateMoves} disabled={loading || !isOnline}>
            {loading ? (
              <>
                <LyraLoader size={20} label="Generating strategic moves..." />
              </>
            ) : (
              <>
                <Sparkles className="h-3 w-3 mr-1" />
                Generate Moves
              </>
            )}
          </Button>
        </div>

        {!isOnline && suggested.length === 0 && (
          <Card className="rounded-lg border bg-card/50 p-6 text-center text-sm text-muted-foreground">
            Start Ollama to generate strategic moves
          </Card>
        )}

        {loading && suggested.length === 0 && (
          <Card className="rounded-lg border bg-card/50 p-8 flex items-center justify-center">
            <LyraLoader size={32} label="Generating strategic moves..." />
          </Card>
        )}

        {suggested.length > 0 && (
          <div className="grid gap-3 md:grid-cols-3">
            {suggested.slice(0, 3).map((move) => (
              <MoveCard
                key={move.id}
                move={move}
                onAccept={() => acceptMove(move.id)}
                onPass={() => passMove(move.id)}
              />
            ))}
          </div>
        )}
      </section>

      <Separator />

      {/* Section 2: Knowledge Pulse */}
      <section>
        <SectionHeader>Knowledge Pulse</SectionHeader>
        <div className="space-y-3">
          {/* Top themes */}
          <div className="flex flex-wrap gap-1.5">
            {knowledgePulse.topThemes.map(([tag, count]) => (
              <Badge key={tag} variant="outline" className="text-xs">
                {tag}{' '}
                <span className="ml-1 text-muted-foreground">{count}</span>
              </Badge>
            ))}
            {knowledgePulse.topThemes.length === 0 && (
              <span className="text-xs text-muted-foreground">No themes yet</span>
            )}
          </div>

          {/* Stats row */}
          <p className="text-xs text-muted-foreground">
            {knowledgePulse.unactionedIdeas} ideas unactioned &middot;{' '}
            {knowledgePulse.openQuestions} questions open &middot;{' '}
            {knowledgePulse.staleNotes} notes stale
          </p>

          {/* Thinking velocity */}
          <p className="text-xs">
            {knowledgePulse.notesThisWeek} notes/week
            <TrendArrow
              current={knowledgePulse.notesThisWeek}
              previous={knowledgePulse.notesLastWeek}
            />
          </p>
        </div>
      </section>

      {externalSignals && (
        <>
          <Separator />

          {/* Section 2.5: External Signals */}
          <section>
            <SectionHeader>External Signals</SectionHeader>
            <div className="rounded-lg border bg-card/50 p-3">
              <Markdown content={externalSignals} className="text-xs" />
            </div>
          </section>
        </>
      )}

      <Separator />

      {/* Section 3: Scoreboard */}
      <section>
        <SectionHeader>Scoreboard</SectionHeader>

        {/* Metric cards */}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
          {/* Velocity */}
          <Card className="rounded-lg border bg-card/50 p-3 space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Velocity
            </p>
            <p className="text-lg font-semibold">
              {scoreboard.velocity.current}/wk
              <TrendArrow
                current={scoreboard.velocity.current}
                previous={scoreboard.velocity.previous}
              />
            </p>
            <Progress
              value={
                scoreboard.velocity.previous > 0
                  ? Math.min(
                      (scoreboard.velocity.current / scoreboard.velocity.previous) * 100,
                      100,
                    )
                  : scoreboard.velocity.current > 0
                    ? 100
                    : 0
              }
              className="h-1"
            />
          </Card>

          {/* Focus */}
          <Card className="rounded-lg border bg-card/50 p-3 space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Focus</p>
            <p className="text-lg font-semibold">
              {scoreboard.focus.current} active
            </p>
            <Progress
              value={
                scoreboard.focus.total > 0
                  ? (scoreboard.focus.current / scoreboard.focus.total) * 100
                  : 0
              }
              className="h-1"
            />
          </Card>

          {/* Habits */}
          <Card className="rounded-lg border bg-card/50 p-3 space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Habits
            </p>
            <p className="text-lg font-semibold">
              {scoreboard.habits.current}/{scoreboard.habits.total}
            </p>
            <Progress
              value={
                scoreboard.habits.total > 0
                  ? (scoreboard.habits.current / scoreboard.habits.total) * 100
                  : 0
              }
              className="h-1"
            />
          </Card>

          {/* Health */}
          <Card className="rounded-lg border bg-card/50 p-3 space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Health
            </p>
            <p className="text-lg font-semibold">{scoreboard.health.sleep}h sleep</p>
            <Progress
              value={
                typeof scoreboard.health.sleep === 'string' &&
                scoreboard.health.sleep !== '--'
                  ? (parseFloat(scoreboard.health.sleep) / 9) * 100
                  : 0
              }
              className="h-1"
            />
          </Card>

          {/* Wealth */}
          <Card className="rounded-lg border bg-card/50 p-3 space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Wealth
            </p>
            <p className="text-lg font-semibold">
              {scoreboard.wealth.balance > 0
                ? `$${scoreboard.wealth.balance.toLocaleString()}`
                : '--'}
            </p>
            <Progress value={0} className="h-1" />
          </Card>

          {/* Goals */}
          <Card className="rounded-lg border bg-card/50 p-3 space-y-1">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Goals
            </p>
            <p className="text-lg font-semibold">
              {scoreboard.goals.progress}%
              <span className="text-xs text-muted-foreground ml-1">
                ({scoreboard.goals.count})
              </span>
            </p>
            <Progress value={scoreboard.goals.progress} className="h-1" />
          </Card>
        </div>

        {/* Project velocity table */}
        {scoreboard.projectVelocities.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Project Velocity
            </p>
            <div className="space-y-1.5">
              {scoreboard.projectVelocities.map((pv) => (
                <div key={pv.title} className="flex items-center gap-3 text-xs">
                  <span className="w-32 truncate font-medium">{pv.title}</span>
                  <div className="flex-1">
                    <Progress
                      value={pv.total > 0 ? (pv.done / pv.total) * 100 : 0}
                      className="h-1.5"
                    />
                  </div>
                  <span className="text-muted-foreground w-12 text-right">
                    {pv.thisWeek}/wk
                    <TrendArrow current={pv.thisWeek} previous={pv.lastWeek} />
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
