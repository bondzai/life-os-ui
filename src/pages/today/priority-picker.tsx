import { useState } from 'react'
import { Star, ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import type { Entity } from '@/core/types'

interface PriorityPickerProps {
  candidates: Entity[]
  existingIds?: string[]
  onSave: (ids: string[]) => void
}

export function PriorityPicker({ candidates, existingIds = [], onSave }: PriorityPickerProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set(existingIds))
  const maxItems = 3

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else if (next.size < maxItems) {
        next.add(id)
      }
      return next
    })
  }

  const available = candidates.filter((item) => !existingIds.includes(item.id))
  const newSelections = Array.from(selected).filter((id) => !existingIds.includes(id))

  return (
    <Card className="border-dashed border-primary/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Star className="h-4 w-4 text-yellow-500" />
          {existingIds.length > 0 ? 'Add to today\'s focus' : 'Pick your focus for today'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {available.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {candidates.length === 0
              ? 'No active tasks or goals. Create a story in Tasks first.'
              : 'All tasks are already in focus.'
            }
          </p>
        ) : (
          <div className="space-y-1.5 max-h-56 overflow-y-auto">
            {available.map((item) => {
              const hasSubs = Array.isArray(item.metadata.subtasks) && (item.metadata.subtasks as unknown[]).length > 0
              return (
                <div key={item.id} className="flex items-center gap-2 py-0.5">
                  <Checkbox
                    checked={selected.has(item.id)}
                    onCheckedChange={() => toggle(item.id)}
                    disabled={!selected.has(item.id) && selected.size >= maxItems}
                  />
                  <span className="text-sm truncate flex-1">{item.title}</span>
                  {hasSubs && <ListChecks className="h-3 w-3 text-muted-foreground/40 shrink-0" />}
                  <span className="text-[10px] text-muted-foreground/40 capitalize shrink-0">{item.type}</span>
                </div>
              )
            })}
          </div>
        )}

        {newSelections.length > 0 && (
          <Button size="sm" onClick={() => onSave(Array.from(selected))}>
            {existingIds.length > 0 ? 'Add' : 'Set focus'} ({newSelections.length})
          </Button>
        )}

        {candidates.length === 0 && (
          <p className="text-[11px] text-muted-foreground/50">
            Tip: Create stories with subtasks in the Tasks page, then pick them here.
          </p>
        )}
      </CardContent>
    </Card>
  )
}
