import { useState, useRef, useEffect } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'

export function CaptureBar() {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)
  const { create } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)

  // Global shortcut: / to focus capture bar
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.key === '/' &&
        !e.metaKey &&
        !e.ctrlKey &&
        document.activeElement?.tagName !== 'INPUT' &&
        document.activeElement?.tagName !== 'TEXTAREA'
      ) {
        e.preventDefault()
        inputRef.current?.focus()
      }
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [])

  const handleCapture = () => {
    const text = value.trim()
    if (!text) return

    const now = new Date().toISOString()

    // Detect type from prefix
    const isTask = text.startsWith('!') || text.toLowerCase().startsWith('todo ')
    const cleanText = text.replace(/^(!|todo\s+)/i, '').trim()

    create.mutate({
      id: crypto.randomUUID(),
      type: isTask ? 'task' : 'note',
      title: cleanText.slice(0, 120) || 'Inbox item',
      status: 'active',
      priority: 'medium',
      tags: ['inbox'],
      metadata: { body: cleanText, isInbox: true },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
      ...(isTask ? { dueDate: new Date().toISOString().split('T')[0] } : {}),
    })

    setValue('')
    notify({ title: isTask ? 'Task captured' : 'Captured to inbox', type: 'success' })
  }

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            handleCapture()
          }
          if (e.key === 'Escape') {
            setValue('')
            inputRef.current?.blur()
          }
        }}
        placeholder='Capture anything... ( / to focus, "!" for task )'
        className="w-full h-10 rounded-lg border bg-muted/30 px-4 pr-10 text-sm placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:bg-background transition-colors"
      />
      {value && (
        <button
          onClick={handleCapture}
          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-md hover:bg-muted transition-colors"
        >
          <CornerDownLeft className="h-3.5 w-3.5 text-muted-foreground" />
        </button>
      )}
    </div>
  )
}
