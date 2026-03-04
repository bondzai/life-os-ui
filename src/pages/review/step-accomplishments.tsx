import { Trophy } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { Entity } from '@/core/types'

interface StepAccomplishmentsProps {
  items: Entity[]
}

export function StepAccomplishments({ items }: StepAccomplishmentsProps) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Trophy className="h-4 w-4 text-yellow-500" />
          Accomplishments this week
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No completed tasks or goals this week. That's okay — every week is different.
          </p>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-2">
                <span className="text-green-500">&#10003;</span>
                <span className="text-sm flex-1 truncate">{item.title}</span>
                <Badge variant="outline" className="text-xs capitalize">
                  {item.type}
                </Badge>
              </div>
            ))}
            <p className="text-xs text-muted-foreground pt-2">
              {items.length} item{items.length !== 1 ? 's' : ''} completed. Nice work!
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
