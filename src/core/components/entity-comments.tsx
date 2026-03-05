import { useState } from 'react'
import { Send, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { useEntities } from '@/core/hooks'
import type { Entity } from '@/core/types'

interface EntityCommentsProps {
  entityId: string
  currentUserId: string
}

export function EntityComments({ entityId, currentUserId }: EntityCommentsProps) {
  const { items: allComments, create, remove } = useEntities('comment' as Entity['type'])
  const [body, setBody] = useState('')

  const comments = allComments
    .filter((c) => c.parentId === entityId)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))

  const handleSubmit = () => {
    const text = body.trim()
    if (!text) return
    create.mutate({
      id: crypto.randomUUID(),
      type: 'comment' as Entity['type'],
      title: text,
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: {},
      parentId: entityId,
      ownerId: currentUserId,
      visibility: 'shared',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    setBody('')
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="space-y-3">
      <h4 className="text-sm font-medium">Comments ({comments.length})</h4>

      {comments.length > 0 && (
        <div className="space-y-2">
          {comments.map((comment) => (
            <div key={comment.id} className="rounded border p-2 text-sm space-y-1">
              <div className="flex items-start justify-between gap-2">
                <p className="whitespace-pre-wrap flex-1">{comment.title}</p>
                {comment.ownerId === currentUserId && (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-6 w-6 p-0 shrink-0"
                    onClick={() => remove.mutate(comment.id)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {new Date(comment.createdAt).toLocaleString()}
              </p>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a comment... (Cmd+Enter to send)"
          rows={2}
          className="text-sm"
        />
        <Button size="sm" className="shrink-0" onClick={handleSubmit} disabled={!body.trim()}>
          <Send className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  )
}
