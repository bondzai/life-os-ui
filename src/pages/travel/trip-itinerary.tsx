import { useMemo } from 'react'
import { MapPin, CalendarDays } from 'lucide-react'
import type { Entity } from '@/core/types'

interface TripItineraryProps {
  places: Entity[]
}

export function TripItinerary({ places }: TripItineraryProps) {
  const grouped = useMemo(() => {
    const map: Record<string, Entity[]> = {}
    for (const place of places) {
      const date = (place.metadata.visitDate as string) || (place.dueDate as string) || 'Unscheduled'
      if (!map[date]) map[date] = []
      map[date].push(place)
    }
    return Object.entries(map).sort(([a], [b]) => {
      if (a === 'Unscheduled') return 1
      if (b === 'Unscheduled') return -1
      return a.localeCompare(b)
    })
  }, [places])

  if (places.length === 0) return null

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium flex items-center gap-1.5">
        <CalendarDays className="h-4 w-4 text-muted-foreground" />
        Itinerary
      </h4>
      {grouped.map(([date, items]) => (
        <div key={date} className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">
            {date === 'Unscheduled'
              ? 'Unscheduled'
              : new Date(date + 'T00:00:00').toLocaleDateString('en-US', {
                  weekday: 'short',
                  month: 'short',
                  day: 'numeric',
                })}
          </p>
          {items.map((place) => (
            <div key={place.id} className="flex items-center gap-2 rounded-md border px-3 py-2">
              <MapPin className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <span className="text-sm">{place.title}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  )
}
