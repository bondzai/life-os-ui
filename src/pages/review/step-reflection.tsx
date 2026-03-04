import { useState } from 'react'
import { BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'

interface StepReflectionProps {
  onSave: (text: string) => void
  saved: boolean
}

export function StepReflection({ onSave, saved }: StepReflectionProps) {
  const [text, setText] = useState('')

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
            <Button size="sm" disabled={!text.trim()} onClick={() => onSave(text.trim())}>
              Save & Complete Review
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}
