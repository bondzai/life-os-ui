import { useState } from 'react'
import { Star } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import type { Entity } from '@/core/types'

interface PriorityPickerProps {
  candidates: Entity[]
  onSave: (ids: string[]) => void
}

export function PriorityPicker({ candidates, onSave }: PriorityPickerProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set())

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else if (next.size < 3) {
        next.add(id)
      }
      return next
    })
  }

  return (
    <Card className="border-dashed border-primary/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Star className="h-4 w-4 text-yellow-500" />
          Pick your 3 priorities for today
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-2 max-h-48 overflow-y-auto">
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active tasks or goals to prioritize.</p>
          ) : (
            candidates.map((item) => (
              <div key={item.id} className="flex items-center gap-2">
                <Checkbox
                  checked={selected.has(item.id)}
                  onCheckedChange={() => toggle(item.id)}
                  disabled={!selected.has(item.id) && selected.size >= 3}
                />
                <span className="text-sm truncate flex-1">{item.title}</span>
                <span className="text-xs text-muted-foreground capitalize">{item.type}</span>
              </div>
            ))
          )}
        </div>
        {candidates.length > 0 && (
          <Button
            size="sm"
            disabled={selected.size === 0}
            onClick={() => onSave(Array.from(selected))}
          >
            Set priorities ({selected.size}/3)
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
