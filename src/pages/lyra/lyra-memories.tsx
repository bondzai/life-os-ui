import { useState } from 'react'
import { Brain, Trash2, Search } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useLyraMemory, type MemoryCategory } from '@/hooks/use-lyra-memory'

const categoryColors: Record<MemoryCategory, string> = {
  fact: 'bg-blue-500/10 text-blue-600',
  preference: 'bg-purple-500/10 text-purple-600',
  pattern: 'bg-amber-500/10 text-amber-600',
  decision: 'bg-emerald-500/10 text-emerald-600',
  context: 'bg-cyan-500/10 text-cyan-600',
}

function timeAgo(timestamp: string): string {
  const ms = Date.now() - new Date(timestamp).getTime()
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`
  return `${Math.floor(ms / 86_400_000)}d ago`
}

export function LyraMemories() {
  const { memories, removeMemory } = useLyraMemory()
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<MemoryCategory | 'all'>('all')

  const filtered = memories.filter((m) => {
    if (filter !== 'all' && m.category !== filter) return false
    if (search) {
      const q = search.toLowerCase()
      return (
        m.entity.title.toLowerCase().includes(q) ||
        (m.entity.description ?? '').toLowerCase().includes(q)
      )
    }
    return true
  })

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 border-b border-border/40 space-y-2 shrink-0">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Brain className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Memory
            </span>
            <Badge variant="secondary" className="text-[9px] px-1.5 h-4">
              {memories.length}
            </Badge>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search memories..."
              className="h-7 text-xs pl-7"
            />
          </div>
          <div className="inline-flex items-center rounded-md bg-muted p-0.5">
            {(
              ['all', 'fact', 'preference', 'pattern', 'decision', 'context'] as const
            ).map((cat) => (
              <button
                key={cat}
                onClick={() => setFilter(cat)}
                className={`px-1.5 py-0.5 rounded text-[9px] font-medium transition-colors ${
                  filter === cat
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground'
                }`}
              >
                {cat === 'all' ? 'All' : cat.charAt(0).toUpperCase() + cat.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Memory list */}
      <ScrollArea className="flex-1">
        <div className="px-2 py-1 space-y-0.5">
          {filtered.length === 0 ? (
            <p className="text-[10px] text-muted-foreground/40 text-center py-8">
              {memories.length === 0
                ? 'No memories yet. Lyra learns from your conversations.'
                : 'No matching memories.'}
            </p>
          ) : (
            filtered.map((m) => (
              <div
                key={m.entity.id}
                className="group flex items-start gap-2 rounded-md px-2 py-2 hover:bg-muted/30 transition-colors"
              >
                <Badge
                  className={`text-[9px] px-1.5 shrink-0 mt-0.5 ${categoryColors[m.category]}`}
                >
                  {m.category}
                </Badge>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-medium">{m.entity.title}</p>
                  {m.entity.description && (
                    <p className="text-[10px] text-muted-foreground mt-0.5">
                      {m.entity.description}
                    </p>
                  )}
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-[9px] text-muted-foreground/40">{m.source}</span>
                    <span className="text-[9px] text-muted-foreground/40">
                      {timeAgo(m.entity.createdAt)}
                    </span>
                  </div>
                </div>
                <button
                  onClick={() => removeMemory(m.entity.id)}
                  className="opacity-0 group-hover:opacity-100 transition-opacity text-muted-foreground hover:text-destructive shrink-0"
                >
                  <Trash2 className="h-3 w-3" />
                </button>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </div>
  )
}
