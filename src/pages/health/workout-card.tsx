import { Pencil, Trash2, Clock, Flame } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { WORKOUT_COLORS, type WorkoutType } from './health-helpers'
import type { Entity } from '@/core/types'

interface WorkoutCardProps {
  workout: Entity
  onEdit: (workout: Entity) => void
  onDelete: (workout: Entity) => void
}

export function WorkoutCard({ workout, onEdit, onDelete }: WorkoutCardProps) {
  const workoutType = workout.metadata.workoutType as WorkoutType
  const duration = workout.metadata.duration as number
  const calories = workout.metadata.calories as number | undefined
  const exercises = workout.metadata.exercises as string | undefined
  const date = (workout.metadata.date as string) || ''
  const note = workout.metadata.note as string | undefined

  const typeLabel = workoutType === 'hiit' ? 'HIIT' : workoutType.charAt(0).toUpperCase() + workoutType.slice(1)

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm font-medium">{workout.title}</CardTitle>
            <p className="text-xs text-muted-foreground mt-0.5">{date}</p>
          </div>
          <Badge className={`text-xs shrink-0 ${WORKOUT_COLORS[workoutType] || ''}`}>
            {typeLabel}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-1">
            <Clock className="h-3.5 w-3.5 text-muted-foreground" />
            {duration} min
          </span>
          {calories && (
            <span className="flex items-center gap-1">
              <Flame className="h-3.5 w-3.5 text-orange-500" />
              {calories} cal
            </span>
          )}
        </div>
        {exercises && (
          <p className="text-xs text-muted-foreground">{exercises}</p>
        )}
        {note && (
          <p className="text-xs text-muted-foreground italic">{note}</p>
        )}
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onEdit(workout)}>
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => onDelete(workout)}>
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
