import { useState, useMemo } from 'react'
import { BookOpen, Lightbulb } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'
import type { Entity } from '@/core/types'

interface StepReflectionProps {
  onSave: (text: string) => void
  saved: boolean
  allEntities?: Entity[]
}

export function StepReflection({ onSave, saved, allEntities }: StepReflectionProps) {
  const [text, setText] = useState('')

  const suggestedPriorities = useMemo(() => {
    if (!allEntities) return []
    const now = new Date()
    const nextWeek = new Date(now)
    nextWeek.setDate(nextWeek.getDate() + 7)
    const today = now.toISOString().split('T')[0]
    const nextWeekStr = nextWeek.toISOString().split('T')[0]

    return allEntities
      .filter(
        (e) =>
          (e.type === 'task' || e.type === 'goal') &&
          e.status === 'active' &&
          e.dueDate &&
          e.dueDate >= today &&
          e.dueDate <= nextWeekStr,
      )
      .sort((a, b) => {
        const priorityOrder = { urgent: 0, high: 1, medium: 2, low: 3 }
        return (priorityOrder[a.priority] ?? 3) - (priorityOrder[b.priority] ?? 3)
      })
      .slice(0, 5)
  }, [allEntities])

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          Weekly Reflection
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {saved ? (
          <p className="text-sm text-green-600">Reflection saved! Review complete.</p>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              What went well this week? What would you like to improve?
            </p>
            <Textarea
              placeholder="Write your reflection..."
              rows={5}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />

            {suggestedPriorities.length > 0 && (
              <div className="rounded-md border p-3 space-y-1.5">
                <p className="text-xs font-medium flex items-center gap-1.5">
                  <Lightbulb className="h-3.5 w-3.5 text-yellow-500" />
                  Suggested priorities for next week
                </p>
                {suggestedPriorities.map((item) => (
                  <div key={item.id} className="flex items-center gap-2 text-sm">
                    <span className="text-muted-foreground">•</span>
                    <span className="truncate flex-1">{item.title}</span>
                    <span className="text-xs text-muted-foreground shrink-0">
                      due {new Date(item.dueDate! + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </div>
                ))}
              </div>
            )}

            <Button size="sm" disabled={!text.trim()} onClick={() => onSave(text.trim())}>
              Save & Complete Review
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}
