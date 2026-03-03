import { Pencil, Trash2, Moon, Smile, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import {
  MOOD_COLORS,
  SLEEP_COLORS,
  type MoodLevel,
  type SleepQuality,
} from './health-helpers'
import type { Entity } from '@/core/types'

interface SleepMoodCardProps {
  entry: Entity
  onEdit: (entry: Entity) => void
  onDelete: (entry: Entity) => void
}

export function SleepMoodCard({ entry, onEdit, onDelete }: SleepMoodCardProps) {
  const sleepHours = entry.metadata.sleepHours as number | undefined
  const sleepQuality = entry.metadata.sleepQuality as SleepQuality | undefined
  const mood = entry.metadata.mood as MoodLevel | undefined
  const energy = entry.metadata.energy as number | undefined
  const date = (entry.metadata.date as string) || ''
  const note = entry.metadata.note as string | undefined

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-sm font-medium">{date}</CardTitle>
          <div className="flex gap-1 shrink-0">
            {mood && (
              <Badge className={`text-xs capitalize ${MOOD_COLORS[mood]}`}>
                {mood}
              </Badge>
            )}
            {sleepQuality && (
              <Badge className={`text-xs capitalize ${SLEEP_COLORS[sleepQuality]}`}>
                {sleepQuality}
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-4 text-sm">
          {sleepHours != null && (
            <span className="flex items-center gap-1">
              <Moon className="h-3.5 w-3.5 text-indigo-500" />
              {sleepHours}h
            </span>
          )}
          {mood && (
            <span className="flex items-center gap-1">
              <Smile className="h-3.5 w-3.5 text-blue-500" />
              {mood}
            </span>
          )}
          {energy != null && (
            <span className="flex items-center gap-1">
              <Zap className="h-3.5 w-3.5 text-yellow-500" />
              {energy}/10
            </span>
          )}
        </div>
        {note && (
          <p className="text-xs text-muted-foreground italic">{note}</p>
        )}
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onEdit(entry)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onDelete(entry)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
