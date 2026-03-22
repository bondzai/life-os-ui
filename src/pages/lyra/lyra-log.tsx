import { useState } from 'react'
import {
  Info,
  Zap,
  Brain,
  AlertTriangle,
  Trophy,
  Trash2,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useLyraLogStore, type LogLevel } from '@/stores/lyra-log-store'

const levelConfig: Record<LogLevel, { icon: typeof Info; color: string; label: string }> = {
  info: { icon: Info, color: 'text-muted-foreground', label: 'Info' },
  action: { icon: Zap, color: 'text-blue-500', label: 'Action' },
  thinking: { icon: Brain, color: 'text-purple-500', label: 'Thinking' },
  error: { icon: AlertTriangle, color: 'text-red-500', label: 'Error' },
  celebration: { icon: Trophy, color: 'text-emerald-500', label: 'Win' },
}

function timeAgo(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime()
  if (ms < 60_000) return 'just now'
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export function LyraLog() {
  const entries = useLyraLogStore((s) => s.entries)
  const clear = useLyraLogStore((s) => s.clear)
  const [filter, setFilter] = useState<LogLevel | 'all'>('all')

  const filtered = filter === 'all' ? entries : entries.filter((e) => e.level === filter)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border/40 shrink-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Event Log
          </span>
          <Badge variant="secondary" className="text-[9px] px-1.5 h-4">
            {entries.length}
          </Badge>
        </div>
        <div className="flex items-center gap-1">
          {/* Filter */}
          <div className="inline-flex items-center rounded-md bg-muted p-0.5">
            <button
              onClick={() => setFilter('all')}
              className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors ${
                filter === 'all' ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground'
              }`}
            >
              All
            </button>
            {(Object.keys(levelConfig) as LogLevel[]).map((level) => {
              const cfg = levelConfig[level]
              const Icon = cfg.icon
              return (
                <button
                  key={level}
                  onClick={() => setFilter(level)}
                  className={`px-1.5 py-0.5 rounded transition-colors ${
                    filter === level ? 'bg-background shadow-sm' : ''
                  }`}
                  title={cfg.label}
                >
                  <Icon className={`h-3 w-3 ${filter === level ? cfg.color : 'text-muted-foreground/50'}`} />
                </button>
              )
            })}
          </div>
          <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={clear} title="Clear log">
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {/* Entries */}
      <ScrollArea className="flex-1">
        <div className="px-2 py-1 space-y-0.5">
          {filtered.length === 0 ? (
            <p className="text-[10px] text-muted-foreground/40 text-center py-8">
              No events yet. Lyra will log actions here.
            </p>
          ) : (
            filtered.map((entry) => {
              const cfg = levelConfig[entry.level]
              const Icon = cfg.icon
              return (
                <div key={entry.id} className="flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-muted/30 transition-colors">
                  <Icon className={`h-3.5 w-3.5 mt-0.5 shrink-0 ${cfg.color}`} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <span className="text-[10px] font-medium text-muted-foreground/60">{entry.source}</span>
                      <span className="text-[9px] text-muted-foreground/30">{timeAgo(entry.timestamp)}</span>
                      {entry.duration && (
                        <span className="text-[9px] text-muted-foreground/30">{entry.duration}ms</span>
                      )}
                    </div>
                    <p className="text-xs leading-snug">{entry.message}</p>
                    {entry.detail && (
                      <p className="text-[10px] text-muted-foreground truncate mt-0.5">{entry.detail}</p>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
