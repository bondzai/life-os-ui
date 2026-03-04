import { Pencil, Trash2, MapPin, CalendarDays } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { MOOD_EMOJI, MOOD_COLORS, type MemoryMood } from './memory-helpers'
import type { Entity } from '@/core/types'

interface MemoryCardProps {
  memory: Entity
  onEdit: (memory: Entity) => void
  onDelete: (memory: Entity) => void
  onClick: (memory: Entity) => void
}

export function MemoryCard({ memory, onEdit, onDelete, onClick }: MemoryCardProps) {
  const { thumbnailData, mood, location, date, caption } = memory.metadata as {
    thumbnailData?: string
    mood?: string
    location?: string
    date?: string
    caption?: string
  }

  const moodKey = mood as MemoryMood | undefined

  return (
    <Card className="overflow-hidden group">
      {/* Thumbnail */}
      <div
        className="aspect-[4/3] overflow-hidden cursor-pointer bg-muted"
        onClick={() => onClick(memory)}
      >
        {thumbnailData ? (
          <img
            src={thumbnailData as string}
            alt={memory.title}
            className="w-full h-full object-cover transition-transform group-hover:scale-105"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground text-sm">
            No image
          </div>
        )}
      </div>

      <CardContent className="p-3 space-y-2">
        <h3 className="text-sm font-medium truncate">{memory.title}</h3>

        <div className="flex items-center gap-2 text-xs text-muted-foreground flex-wrap">
          {date && (
            <span className="flex items-center gap-1">
              <CalendarDays className="h-3 w-3" />
              {new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              })}
            </span>
          )}
          {moodKey && MOOD_EMOJI[moodKey] && (
            <Badge variant="outline" className={`text-xs ${MOOD_COLORS[moodKey] || ''}`}>
              {MOOD_EMOJI[moodKey]} {moodKey}
            </Badge>
          )}
        </div>

        {location && (
          <p className="text-xs text-muted-foreground flex items-center gap-1">
            <MapPin className="h-3 w-3" />
            {location}
          </p>
        )}

        {caption && (
          <p className="text-xs text-muted-foreground line-clamp-2">{caption}</p>
        )}

        {memory.tags.length > 0 && (
          <div className="flex gap-1 flex-wrap">
            {memory.tags.map((tag) => (
              <span key={tag} className="text-xs bg-secondary px-1.5 py-0.5 rounded">
                {tag}
              </span>
            ))}
          </div>
        )}

        <div className="flex gap-1 pt-1">
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
      </CardContent>
    </Card>
  )
}
