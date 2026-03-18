import { useMemo, useState } from 'react'
import {
  Timer,
  Flame,
  Zap,
  Clock,
  ChevronDown,
  ChevronRight,
  CheckCircle2,
  TrendingUp,
  Calendar,
  Crown,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { useEntities, useTrackers } from '@/core/hooks'
import { formatMinutes as fmtMin } from '@/lib/focus-stats'
import type { Tracker } from '@/core/types'

/* ─── Types ─── */

interface SessionNote {
  sessionId?: string
  task: string
  completed: string[]
  progress?: string
}

interface Session {
  id: string
  entityId: string
  title: string
  minutes: number
  timestamp: string
  time: string
  note: SessionNote | null
  sessionId: string | null
}

interface SessionGroup {
  sessionId: string
  sessions: Session[]
  totalMinutes: number
  startTime: string
  taskCount: number
}

interface DayGroup {
  date: string
  label: string
  /** Ordered list of either a SessionGroup (emperor time block) or standalone Session */
  items: Array<{ type: 'group'; group: SessionGroup } | { type: 'session'; session: Session }>
  totalMinutes: number
  sessionCount: number
}

/* ─── Helpers ─── */

function parseNote(raw?: string | null): SessionNote | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    if (typeof parsed === 'object' && parsed.task) return parsed as SessionNote
  } catch { /* not JSON */ }
  return null
}

function formatDate(dateStr: string): string {
  const d = new Date(dateStr + 'T00:00:00')
  const today = new Date().toISOString().split('T')[0]
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0]
  if (dateStr === today) return 'Today'
  if (dateStr === yesterday) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}

function getHour(ts: string): number {
  return new Date(ts).getHours()
}

/* ─── Peak Hours Chart ─── */

function PeakHoursChart({ sessions }: { sessions: Session[] }) {
  const hourData = useMemo(() => {
    const buckets = Array.from({ length: 24 }, (_, i) => ({ hour: i, minutes: 0 }))
    for (const s of sessions) {
      const h = getHour(s.timestamp)
      buckets[h].minutes += s.minutes
    }
    return buckets
  }, [sessions])

  const maxMin = Math.max(...hourData.map((h) => h.minutes), 1)

  // Show only 6am–midnight for cleaner view
  const visibleHours = hourData.filter((h) => h.hour >= 6 && h.hour < 24)

  return (
    <div className="space-y-2">
      <div className="flex items-end gap-[3px] h-20">
        {visibleHours.map((h) => {
          const pct = h.minutes > 0 ? Math.max((h.minutes / maxMin) * 100, 4) : 0
          return (
            <div key={h.hour} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full flex items-end justify-center" style={{ height: '56px' }}>
                {h.minutes > 0 ? (
                  <div
                    className="w-full max-w-[14px] rounded-t bg-amber-500/60"
                    style={{ height: `${pct}%` }}
                    title={`${h.hour}:00 — ${fmtMin(h.minutes)}`}
                  />
                ) : (
                  <div className="w-full max-w-[14px] h-[1px] bg-muted/30" />
                )}
              </div>
              {h.hour % 3 === 0 && (
                <span className="text-[8px] text-muted-foreground/50 tabular-nums">
                  {h.hour.toString().padStart(2, '0')}
                </span>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ─── Session Item (single tracker entry) ─── */

function SessionItem({ session }: { session: Session }) {
  return (
    <div className="relative">
      {/* Dot */}
      <div className="absolute left-[-18px] top-1.5 w-[7px] h-[7px] rounded-full bg-amber-500/70 ring-2 ring-background" />

      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">{session.time}</span>
          <span className="text-sm font-medium truncate flex-1">{session.title}</span>
          <span className="text-xs text-muted-foreground tabular-nums shrink-0">{session.minutes}m</span>
          {session.note?.progress && (
            <span className="text-[9px] text-muted-foreground/50 tabular-nums shrink-0">{session.note.progress}</span>
          )}
        </div>

        {/* What was accomplished */}
        {session.note?.completed && session.note.completed.length > 0 && (
          <div className="space-y-0.5 ml-12">
            {session.note.completed.map((item, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <CheckCircle2 className="h-3 w-3 text-green-500/60 shrink-0" />
                <span className="text-xs text-muted-foreground">{item}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Session Group Block (Emperor Time session) ─── */

function SessionGroupBlock({ group }: { group: SessionGroup }) {
  const [expanded, setExpanded] = useState(true)
  const uniqueTasks = new Set(group.sessions.map((s) => s.title))
  const totalCompleted = group.sessions.reduce((sum, s) => sum + (s.note?.completed?.length ?? 0), 0)

  return (
    <div className="relative">
      {/* Group dot — crown */}
      <div className="absolute left-[-20px] top-1 w-[11px] h-[11px] rounded-full bg-amber-500 ring-2 ring-background flex items-center justify-center">
        <Crown className="h-[7px] w-[7px] text-background" />
      </div>

      <div className="rounded-lg border border-amber-500/15 bg-amber-500/[0.03] overflow-hidden">
        {/* Group header */}
        <button
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-2 w-full px-3 py-2 text-left hover:bg-amber-500/[0.03] transition-colors"
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3 text-amber-500/50 shrink-0" />
          ) : (
            <ChevronRight className="h-3 w-3 text-amber-500/50 shrink-0" />
          )}
          <span className="text-[10px] text-muted-foreground/60 tabular-nums shrink-0">{group.startTime}</span>
          <span className="text-[9px] font-medium uppercase tracking-wider text-amber-500/70 flex-1">
            Emperor Time
          </span>
          <span className="text-[10px] text-muted-foreground/50 tabular-nums">
            {uniqueTasks.size} task{uniqueTasks.size !== 1 ? 's' : ''}
          </span>
          {totalCompleted > 0 && (
            <span className="text-[10px] text-green-500/60 tabular-nums">
              {totalCompleted} done
            </span>
          )}
          <span className="text-xs font-medium tabular-nums text-amber-500 shrink-0">{fmtMin(group.totalMinutes)}</span>
        </button>

        {expanded && (
          <div className="px-3 pb-2.5 space-y-1.5">
            {group.sessions.map((session) => (
              <div key={session.id} className="flex items-start gap-2 py-1">
                <div className="w-1.5 h-1.5 rounded-full bg-amber-500/40 mt-1.5 shrink-0" />
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-sm truncate flex-1">{session.title}</span>
                    <span className="text-xs text-muted-foreground tabular-nums shrink-0">{session.minutes}m</span>
                    {session.note?.progress && (
                      <span className="text-[9px] text-muted-foreground/50 tabular-nums shrink-0">{session.note.progress}</span>
                    )}
                  </div>
                  {session.note?.completed && session.note.completed.length > 0 && (
                    <div className="space-y-0.5 ml-0">
                      {session.note.completed.map((item, i) => (
                        <div key={i} className="flex items-center gap-1.5">
                          <CheckCircle2 className="h-2.5 w-2.5 text-green-500/60 shrink-0" />
                          <span className="text-[11px] text-muted-foreground">{item}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/* ─── Day Section ─── */

function DaySection({ group }: { group: DayGroup }) {
  const [expanded, setExpanded] = useState(group.label === 'Today')

  return (
    <div className="border border-border/50 rounded-lg overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-3 w-full p-3 hover:bg-muted/30 transition-colors text-left"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50 shrink-0" />
        )}
        <span className="text-sm font-medium flex-1">{group.label}</span>
        <span className="text-[10px] text-muted-foreground tabular-nums">{group.sessionCount} session{group.sessionCount !== 1 ? 's' : ''}</span>
        <span className="text-xs font-medium tabular-nums text-amber-500">{fmtMin(group.totalMinutes)}</span>
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          {/* Timeline */}
          <div className="relative pl-6 space-y-3">
            <div className="absolute left-[9px] top-1 bottom-1 w-[1px] bg-border/50" />
            {group.items.map((item) =>
              item.type === 'group' ? (
                <SessionGroupBlock key={item.group.sessionId} group={item.group} />
              ) : (
                <SessionItem key={item.session.id} session={item.session} />
              ),
            )}
          </div>
        </div>
      )}
    </div>
  )
}

/* ─── Main Component ─── */

export function FocusLog() {
  const { items: allEntities } = useEntities()
  const { items: allTrackers } = useTrackers()

  const entityTitles = useMemo(() => {
    const m = new Map<string, string>()
    for (const e of allEntities) m.set(e.id, e.title)
    return m
  }, [allEntities])

  // All focus sessions
  const allSessions = useMemo(() => {
    return allTrackers
      .filter((t) => t.unit === 'focus-min')
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .map((t: Tracker) => {
        const note = parseNote(t.note)
        return {
          id: t.id,
          entityId: t.entityId,
          title: entityTitles.get(t.entityId) || 'Unknown',
          minutes: t.value,
          timestamp: t.timestamp,
          time: new Date(t.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          note,
          sessionId: note?.sessionId ?? null,
        }
      })
  }, [allTrackers, entityTitles])

  // Group by day, then within each day group by sessionId
  const dayGroups = useMemo(() => {
    const dayMap = new Map<string, Session[]>()
    for (const s of allSessions) {
      const date = s.timestamp.split('T')[0]
      const list = dayMap.get(date) ?? []
      list.push(s)
      dayMap.set(date, list)
    }

    return Array.from(dayMap.entries())
      .map(([date, sessions]) => {
        // Build items: group sessions with same sessionId together
        const items: DayGroup['items'] = []
        const usedIds = new Set<string>()

        for (const session of sessions) {
          if (usedIds.has(session.id)) continue

          if (session.sessionId) {
            // Find all sessions in this emperor time block
            const groupSessions = sessions.filter((s) => s.sessionId === session.sessionId)
            if (groupSessions.length > 1) {
              // Multi-task emperor time — show as group
              const alreadyAdded = groupSessions.some((s) => usedIds.has(s.id))
              if (!alreadyAdded) {
                for (const gs of groupSessions) usedIds.add(gs.id)
                items.push({
                  type: 'group',
                  group: {
                    sessionId: session.sessionId,
                    sessions: groupSessions,
                    totalMinutes: groupSessions.reduce((sum, s) => sum + s.minutes, 0),
                    startTime: groupSessions[groupSessions.length - 1].time, // earliest
                    taskCount: new Set(groupSessions.map((s) => s.entityId)).size,
                  },
                })
              }
              continue
            }
          }

          // Standalone session (no sessionId or single-task emperor time)
          usedIds.add(session.id)
          items.push({ type: 'session', session })
        }

        return {
          date,
          label: formatDate(date),
          items,
          totalMinutes: sessions.reduce((sum, s) => sum + s.minutes, 0),
          sessionCount: sessions.length,
        }
      })
      .sort((a, b) => b.date.localeCompare(a.date))
  }, [allSessions])

  // ─── Insights ───
  const insights = useMemo(() => {
    if (allSessions.length === 0) return null

    // Total
    const totalMinutes = allSessions.reduce((sum, s) => sum + s.minutes, 0)
    const totalSessions = allSessions.length

    // Avg session length
    const avgSession = Math.round(totalMinutes / totalSessions)

    // Peak hour
    const hourBuckets = new Map<number, number>()
    for (const s of allSessions) {
      const h = getHour(s.timestamp)
      hourBuckets.set(h, (hourBuckets.get(h) ?? 0) + s.minutes)
    }
    let peakHour = 9
    let peakMin = 0
    for (const [h, min] of hourBuckets) {
      if (min > peakMin) { peakHour = h; peakMin = min }
    }

    // Best day of week
    const dayBuckets = new Map<number, number>()
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
    for (const s of allSessions) {
      const d = new Date(s.timestamp).getDay()
      dayBuckets.set(d, (dayBuckets.get(d) ?? 0) + s.minutes)
    }
    let bestDay = 1
    let bestDayMin = 0
    for (const [d, min] of dayBuckets) {
      if (min > bestDayMin) { bestDay = d; bestDayMin = min }
    }

    // Subtasks completed across all sessions
    const totalCompleted = allSessions.reduce((sum, s) => sum + (s.note?.completed?.length ?? 0), 0)

    // Longest streak (consecutive days)
    const dateSet = new Set(allSessions.map((s) => s.timestamp.split('T')[0]))
    let streak = 0
    let maxStreak = 0
    for (let i = 0; i < 365; i++) {
      const d = new Date()
      d.setDate(d.getDate() - i)
      if (dateSet.has(d.toISOString().split('T')[0])) {
        streak++
        if (streak > maxStreak) maxStreak = streak
      } else if (i > 0) {
        streak = 0
      }
    }

    // Emperor Time session count
    const emperorSessions = new Set(allSessions.filter((s) => s.sessionId).map((s) => s.sessionId)).size

    return {
      totalMinutes,
      totalSessions,
      avgSession,
      peakHour: `${peakHour.toString().padStart(2, '0')}:00`,
      bestDay: dayNames[bestDay],
      totalCompleted,
      longestStreak: maxStreak,
      emperorSessions,
    }
  }, [allSessions])

  // Last 30 days sessions for peak hours
  const last30Sessions = useMemo(() => {
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - 30)
    const cutoffStr = cutoff.toISOString()
    return allSessions.filter((s) => s.timestamp >= cutoffStr)
  }, [allSessions])

  if (allSessions.length === 0) {
    return (
      <div className="text-center py-12 space-y-3">
        <Crown className="h-8 w-8 mx-auto text-amber-500/30" />
        <p className="text-sm text-muted-foreground">No focus sessions yet.</p>
        <p className="text-xs text-muted-foreground/50">Enter Emperor Time from the Today page to start tracking.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Insight cards */}
      {insights && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2">
          {[
            { label: 'Total Focus', value: fmtMin(insights.totalMinutes), icon: Timer },
            { label: 'Sessions', value: `${insights.totalSessions}`, icon: Flame },
            { label: 'Avg Length', value: `${insights.avgSession}m`, icon: Clock },
            { label: 'Peak Hour', value: insights.peakHour, icon: TrendingUp },
            { label: 'Best Day', value: insights.bestDay, icon: Calendar },
            { label: 'Completed', value: `${insights.totalCompleted}`, icon: CheckCircle2 },
            { label: 'Best Streak', value: `${insights.longestStreak}d`, icon: Zap },
          ].map((stat) => (
            <div key={stat.label} className="bg-muted/20 rounded-lg p-2.5 text-center">
              <stat.icon className="h-3.5 w-3.5 mx-auto text-muted-foreground/40 mb-1" />
              <p className="text-sm font-semibold tabular-nums">{stat.value}</p>
              <p className="text-[9px] text-muted-foreground/50 uppercase tracking-wider">{stat.label}</p>
            </div>
          ))}
        </div>
      )}

      {/* Peak hours distribution */}
      <Card className="p-4">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-3">
          <Clock className="h-3 w-3 inline mr-1 -mt-px" />
          Peak Focus Hours — Last 30 Days
        </p>
        <PeakHoursChart sessions={last30Sessions} />
        <p className="text-[9px] text-muted-foreground/40 mt-2 text-center">6:00 — 23:00</p>
      </Card>

      {/* Session timeline by day */}
      <div>
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-3">
          <Crown className="h-3 w-3 inline mr-1 -mt-px text-amber-500/60" />
          Session History
        </p>
        <div className="space-y-2">
          {dayGroups.map((group) => (
            <DaySection key={group.date} group={group} />
          ))}
        </div>
      </div>
    </div>
  )
}
