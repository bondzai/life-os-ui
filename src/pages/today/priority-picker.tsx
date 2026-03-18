import { useState, useMemo } from 'react'
import { Star, ListChecks, Search, Zap, Briefcase, User } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import type { Entity } from '@/core/types'

interface PriorityPickerProps {
  candidates: Entity[]
  existingIds?: string[]
  onSave: (ids: string[]) => void
}

type WsFilter = 'all' | 'work' | 'personal'

const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, medium: 2, low: 3 }

function scoreSuggestion(item: Entity, today: string): number {
  let score = 0
  // In-progress items get highest boost
  if (item.status === 'in-progress') score += 50
  // Due today or overdue
  if (item.dueDate && item.dueDate <= today) score += 40
  // Due this week
  if (item.dueDate) {
    const d = new Date(today)
    d.setDate(d.getDate() + 7)
    if (item.dueDate <= d.toISOString().split('T')[0]) score += 20
  }
  // High priority
  const p = (item.priority as string) || 'medium'
  if (p === 'urgent') score += 30
  if (p === 'high') score += 20
  // Has subtasks (stories are better focus items)
  if (Array.isArray(item.metadata.subtasks) && (item.metadata.subtasks as unknown[]).length > 0) score += 10
  return score
}

export function PriorityPicker({ candidates, existingIds = [], onSave }: PriorityPickerProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set(existingIds))
  const [search, setSearch] = useState('')
  const [wsFilter, setWsFilter] = useState<WsFilter>('all')
  const maxItems = 3

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else if (next.size < maxItems) {
        next.add(id)
      }
      return next
    })
  }

  const today = useMemo(() => new Date().toISOString().split('T')[0], [])

  const available = useMemo(
    () => candidates.filter((item) => !existingIds.includes(item.id)),
    [candidates, existingIds],
  )

  // Suggested items: top 3 by score (only items scoring > 0)
  const suggested = useMemo(() => {
    const scored = available
      .map((item) => ({ item, score: scoreSuggestion(item, today) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)
    return scored.map((s) => s.item)
  }, [available, today])

  const suggestedIds = useMemo(() => new Set(suggested.map((s) => s.id)), [suggested])

  // Filtered list (excludes suggested to avoid duplicates)
  const filtered = useMemo(() => {
    let items = available.filter((item) => !suggestedIds.has(item.id))
    if (wsFilter !== 'all') {
      items = items.filter((item) => {
        const ws = (item.metadata.workspace as string) || 'personal'
        return ws === wsFilter
      })
    }
    if (search.trim()) {
      const q = search.toLowerCase()
      items = items.filter((item) => item.title.toLowerCase().includes(q))
    }
    // Sort by priority
    items.sort((a, b) => {
      const pa = PRIORITY_ORDER[(a.priority as string) || 'medium'] ?? 3
      const pb = PRIORITY_ORDER[(b.priority as string) || 'medium'] ?? 3
      return pa - pb
    })
    return items
  }, [available, suggestedIds, wsFilter, search])

  const newSelections = Array.from(selected).filter((id) => !existingIds.includes(id))

  function ItemRow({ item, isSuggested }: { item: Entity; isSuggested?: boolean }) {
    const hasSubs = Array.isArray(item.metadata.subtasks) && (item.metadata.subtasks as unknown[]).length > 0
    const ws = (item.metadata.workspace as string) || 'personal'
    const isOverdue = item.dueDate && item.dueDate <= today
    const p = (item.priority as string) || ''
    return (
      <div className={`flex items-center gap-2 py-1 px-1.5 rounded-md ${isSuggested ? 'bg-yellow-500/5' : 'hover:bg-muted/50'}`}>
        <Checkbox
          checked={selected.has(item.id)}
          onCheckedChange={() => toggle(item.id)}
          disabled={!selected.has(item.id) && selected.size >= maxItems}
        />
        <span className="text-sm truncate flex-1">{item.title}</span>
        {isOverdue && <span className="text-[9px] font-medium text-destructive shrink-0">DUE</span>}
        {(p === 'urgent' || p === 'high') && (
          <span className={`text-[9px] font-medium shrink-0 ${p === 'urgent' ? 'text-red-500' : 'text-orange-500'}`}>
            {p === 'urgent' ? '!!!' : '!!'}
          </span>
        )}
        {hasSubs && <ListChecks className="h-3 w-3 text-muted-foreground/40 shrink-0" />}
        <span className={`text-[9px] px-1 py-0.5 rounded shrink-0 ${ws === 'work' ? 'bg-blue-500/10 text-blue-600 dark:text-blue-400' : 'bg-green-500/10 text-green-600 dark:text-green-400'}`}>
          {ws === 'work' ? 'W' : 'P'}
        </span>
        <span className="text-[10px] text-muted-foreground/40 capitalize shrink-0">{item.type}</span>
      </div>
    )
  }

  return (
    <Card className="border-dashed border-primary/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Star className="h-4 w-4 text-yellow-500" />
          {existingIds.length > 0 ? 'Add to today\'s focus' : 'Pick your focus for today'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {available.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {candidates.length === 0
              ? 'No active tasks or goals. Create a story in Tasks first.'
              : 'All tasks are already in focus.'
            }
          </p>
        ) : (
          <>
            {/* Suggested */}
            {suggested.length > 0 && (
              <div className="space-y-1">
                <p className="text-[10px] font-medium text-muted-foreground/60 uppercase tracking-wider flex items-center gap-1">
                  <Zap className="h-3 w-3 text-yellow-500" /> Suggested
                </p>
                {suggested.map((item) => (
                  <ItemRow key={item.id} item={item} isSuggested />
                ))}
              </div>
            )}

            {/* Filters */}
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/40" />
                <input
                  type="text"
                  placeholder="Filter..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="w-full text-sm bg-muted/30 border border-border/50 rounded-md pl-7 pr-2 py-1 focus:outline-none focus:ring-1 focus:ring-primary/30 placeholder:text-muted-foreground/30"
                />
              </div>
              <div className="flex gap-0.5">
                {(['all', 'work', 'personal'] as const).map((ws) => (
                  <button
                    key={ws}
                    onClick={() => setWsFilter(ws)}
                    className={`text-[10px] px-1.5 py-0.5 rounded-md transition-colors ${wsFilter === ws ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'}`}
                  >
                    {ws === 'all' ? 'All' : ws === 'work' ? <Briefcase className="h-3 w-3 inline" /> : <User className="h-3 w-3 inline" />}
                  </button>
                ))}
              </div>
            </div>

            {/* All items */}
            <div className="space-y-0.5 max-h-56 overflow-y-auto">
              {filtered.length === 0 ? (
                <p className="text-xs text-muted-foreground/50 py-2 text-center">No matching items</p>
              ) : (
                filtered.map((item) => <ItemRow key={item.id} item={item} />)
              )}
            </div>
          </>
        )}

        {newSelections.length > 0 && (
          <Button size="sm" onClick={() => onSave(Array.from(selected))}>
            {existingIds.length > 0 ? 'Add' : 'Set focus'} ({newSelections.length})
          </Button>
        )}

        {candidates.length === 0 && (
          <p className="text-[11px] text-muted-foreground/50">
            Tip: Create stories with subtasks in the Tasks page, then pick them here.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
