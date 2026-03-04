import { useMemo } from 'react'
import { Camera } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Entity } from '@/core/types'

interface OnThisDayWidgetProps {
  memories: Entity[]
}

export function OnThisDayWidget({ memories }: OnThisDayWidgetProps) {
  const today = new Date()
  const mmdd = `${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`
  const thisYear = today.getFullYear().toString()

  const matches = useMemo(() => {
    return memories.filter((m) => {
      const date = (m.metadata.date as string) || m.createdAt.split('T')[0]
      // Match MM-DD but not current year
      return date.slice(5) === mmdd && !date.startsWith(thisYear)
    })
  }, [memories, mmdd, thisYear])

  if (matches.length === 0) return null

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Camera className="h-4 w-4 text-muted-foreground" />
          On This Day
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="flex gap-2 overflow-x-auto">
          {matches.map((memory) => {
            const thumbnail = memory.metadata.thumbnailData as string | undefined
            const date = (memory.metadata.date as string) || memory.createdAt.split('T')[0]
            const year = date.split('-')[0]
            return (
              <div key={memory.id} className="shrink-0 text-center">
                {thumbnail ? (
                  <img
                    src={thumbnail}
                    alt={memory.title}
                    className="w-16 h-16 rounded object-cover"
                  />
                ) : (
                  <div className="w-16 h-16 rounded bg-muted flex items-center justify-center">
                    <Camera className="h-6 w-6 text-muted-foreground" />
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground mt-0.5">{year}</p>
              </div>
            )
          })}
        </div>
      </CardContent>
    </Card>
  )
}
