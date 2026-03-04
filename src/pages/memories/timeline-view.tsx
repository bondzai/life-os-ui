import { CalendarDays, MapPin, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { MOOD_EMOJI, MOOD_COLORS, type MemoryMood } from './memory-helpers'
import type { Entity } from '@/core/types'

interface TimelineViewProps {
  memories: Entity[]
  onEdit: (memory: Entity) => void
  onDelete: (memory: Entity) => void
  onClick: (memory: Entity) => void
}

function groupByMonth(memories: Entity[]): [string, Entity[]][] {
  const groups: Record<string, Entity[]> = {}
  for (const m of memories) {
    const date = (m.metadata.date as string) || m.createdAt.split('T')[0]
    const key = date.slice(0, 7) // YYYY-MM
    if (!groups[key]) groups[key] = []
    groups[key].push(m)
  }
  return Object.entries(groups).sort(([a], [b]) => b.localeCompare(a))
}

function formatMonthYear(key: string): string {
  const [year, month] = key.split('-')
  const date = new Date(Number(year), Number(month) - 1)
  return date.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
}

export function TimelineView({ memories, onEdit, onDelete, onClick }: TimelineViewProps) {
  const grouped = groupByMonth(memories)

  return (
    <div className="space-y-6">
      {grouped.map(([monthKey, items]) => (
        <div key={monthKey} className="space-y-2">
          <h3 className="text-sm font-semibold text-muted-foreground sticky top-0 bg-background py-1">
            {formatMonthYear(monthKey)}
          </h3>
          <div className="space-y-2">
            {items.map((memory) => {
              const { thumbnailData, mood, location, date, caption } = memory.metadata as {
                thumbnailData?: string
                mood?: string
                location?: string
                date?: string
                caption?: string
              }
              const moodKey = mood as MemoryMood | undefined

              return (
                <div
                  key={memory.id}
                  className="flex gap-3 items-start p-2 rounded-lg hover:bg-muted/50 cursor-pointer"
                  onClick={() => onClick(memory)}
                >
                  {/* Thumbnail */}
                  <div className="w-20 h-16 rounded overflow-hidden shrink-0 bg-muted">
                    {thumbnailData ? (
                      <img
                        src={thumbnailData as string}
                        alt={memory.title}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center text-xs text-muted-foreground">
                        No img
                      </div>
                    )}
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{memory.title}</span>
                      {moodKey && MOOD_EMOJI[moodKey] && (
                        <Badge variant="outline" className={`text-xs shrink-0 ${MOOD_COLORS[moodKey] || ''}`}>
                          {MOOD_EMOJI[moodKey]} {moodKey}
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-muted-foreground">
                      {date && (
                        <span className="flex items-center gap-1">
                          <CalendarDays className="h-3 w-3" />
                          {new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
                            month: 'short',
                            day: 'numeric',
                          })}
                        </span>
                      )}
                      {location && (
                        <span className="flex items-center gap-1">
                          <MapPin className="h-3 w-3" />
                          {location}
                        </span>
                      )}
                    </div>
                    {caption && (
                      <p className="text-xs text-muted-foreground line-clamp-1">{caption}</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={(e) => {
                        e.stopPropagation()
                        onEdit(memory)
                      }}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 px-2"
                      onClick={(e) => {
                        e.stopPropagation()
                        onDelete(memory)
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      ))}
    </div>
  )
}
