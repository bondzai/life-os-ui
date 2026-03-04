import { X, MapPin, CalendarDays } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { MOOD_EMOJI, MOOD_COLORS, type MemoryMood } from './memory-helpers'
import type { Entity } from '@/core/types'

interface MemoryLightboxProps {
  memory: Entity | null
  onClose: () => void
}

export function MemoryLightbox({ memory, onClose }: MemoryLightboxProps) {
  if (!memory) return null

  const { imageData, mood, location, date, caption } = memory.metadata as {
    imageData?: string
    mood?: string
    location?: string
    date?: string
    caption?: string
  }

  const moodKey = mood as MemoryMood | undefined

  return (
    <div
      className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="relative max-w-3xl w-full max-h-[90vh] overflow-y-auto bg-background rounded-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <Button
          size="icon"
          variant="ghost"
          className="absolute top-2 right-2 z-10 text-muted-foreground hover:text-foreground"
          onClick={onClose}
        >
          <X className="h-5 w-5" />
        </Button>

        {imageData && (
          <img
            src={imageData as string}
            alt={memory.title}
            className="w-full rounded-t-lg object-contain max-h-[60vh]"
          />
        )}

        <div className="p-4 space-y-3">
          <h2 className="text-lg font-semibold">{memory.title}</h2>

          <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
            {date && (
              <span className="flex items-center gap-1">
                <CalendarDays className="h-4 w-4" />
                {new Date(date + 'T00:00:00').toLocaleDateString(undefined, {
                  weekday: 'long',
                  month: 'long',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </span>
            )}
            {location && (
              <span className="flex items-center gap-1">
                <MapPin className="h-4 w-4" />
                {location}
              </span>
            )}
            {moodKey && MOOD_EMOJI[moodKey] && (
              <Badge variant="outline" className={MOOD_COLORS[moodKey] || ''}>
                {MOOD_EMOJI[moodKey]} {moodKey}
              </Badge>
            )}
          </div>

          {caption && <p className="text-sm text-muted-foreground">{caption}</p>}

          {memory.tags.length > 0 && (
            <div className="flex gap-1 flex-wrap">
              {memory.tags.map((tag) => (
                <span key={tag} className="text-xs bg-secondary px-1.5 py-0.5 rounded">
                  {tag}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
