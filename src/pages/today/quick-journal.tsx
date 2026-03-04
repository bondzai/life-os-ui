import { useState } from 'react'
import { BookOpen } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Textarea } from '@/components/ui/textarea'

interface QuickJournalProps {
  onSave: (text: string) => void
}

export function QuickJournal({ onSave }: QuickJournalProps) {
  const [text, setText] = useState('')

  const handleSave = () => {
    if (!text.trim()) return
    onSave(text.trim())
    setText('')
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <BookOpen className="h-4 w-4 text-muted-foreground" />
          Quick Journal
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Textarea
          placeholder="How's your day going? What's on your mind?"
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <Button size="sm" disabled={!text.trim()} onClick={handleSave}>
          Save Entry
        </Button>
      </CardContent>
    </Card>
  )
}
