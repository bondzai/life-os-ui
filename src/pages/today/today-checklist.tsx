import { CalendarDays } from 'lucide-react'
import { Checkbox } from '@/components/ui/checkbox'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Entity } from '@/core/types'

interface TodayChecklistProps {
  title: string
  icon: React.ReactNode
  items: Entity[]
  onToggle: (item: Entity) => void
}

export function TodayChecklist({ title, icon, items, onToggle }: TodayChecklistProps) {
  const today = new Date().toISOString().split('T')[0]

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          {icon}
          {title}
          {items.length > 0 && (
            <span className="text-xs text-muted-foreground ml-auto">
              {items.filter((i) => i.status === 'completed').length}/{items.length}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {items.length === 0 ? (
          <p className="text-sm text-muted-foreground">All clear!</p>
        ) : (
          <div className="space-y-2">
            {items.map((item) => (
              <div key={item.id} className="flex items-center gap-2">
                <Checkbox
                  checked={item.status === 'completed'}
                  onCheckedChange={() => onToggle(item)}
                />
                <span
                  className={`text-sm truncate flex-1 ${
                    item.status === 'completed' ? 'line-through text-muted-foreground' : ''
                  }`}
                >
                  {item.title}
                </span>
                {item.dueDate && item.dueDate < today && (
                  <span className="text-xs text-destructive shrink-0 flex items-center gap-1">
                    <CalendarDays className="h-3 w-3" /> overdue
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
