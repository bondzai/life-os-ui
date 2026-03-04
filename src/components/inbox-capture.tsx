import { useState, useEffect, useCallback } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'

export function InboxCapture() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const { create, items } = useEntities('note')
  const currentUser = useAuthStore((s) => s.currentUser)

  const inboxCount = items.filter(
    (e) => e.metadata.isInbox === true && e.status === 'active',
  ).length

  // Keyboard shortcut: Cmd+Shift+I
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key === 'i') {
        e.preventDefault()
        setOpen(true)
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const handleSave = useCallback(() => {
    if (!text.trim()) return
    const title = text.trim().slice(0, 50) || 'Inbox item'
    create.mutate({
      id: crypto.randomUUID(),
      type: 'note',
      title,
      status: 'active',
      priority: 'medium',
      tags: ['inbox'],
      metadata: { body: text.trim(), isInbox: true, isJournal: false },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    setText('')
    setOpen(false)
    notify({ title: 'Captured to inbox', type: 'success' })
  }, [text, create, currentUser])

  // Enter to save (Shift+Enter for newline)
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSave()
    }
  }

  return (
    <>
      {/* Floating button */}
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 w-12 h-12 rounded-full bg-primary text-primary-foreground shadow-lg hover:opacity-90 transition-opacity flex items-center justify-center"
        aria-label="Quick capture"
      >
        <Plus className="h-5 w-5" />
        {inboxCount > 0 && (
          <span className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-destructive text-destructive-foreground text-xs flex items-center justify-center">
            {inboxCount > 9 ? '9+' : inboxCount}
          </span>
        )}
      </button>

      {/* Capture dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">Quick Capture</DialogTitle>
          </DialogHeader>
          <Textarea
            placeholder="What's on your mind? (Enter to save, Shift+Enter for newline)"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
          <DialogFooter>
            <Button size="sm" disabled={!text.trim()} onClick={handleSave}>
              Save to Inbox
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
