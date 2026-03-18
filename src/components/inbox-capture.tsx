import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Plus,
  CheckSquare,
  NotebookPen,
  Lightbulb,
  Target,
  Repeat,
  CalendarIcon,
  X,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'
import type { EntityType, EntityStatus, EntityPriority } from '@/core/types'
import type { LucideIcon } from 'lucide-react'

type CaptureType = 'task' | 'note' | 'idea' | 'goal' | 'habit'

interface CaptureTypeOption {
  key: CaptureType
  label: string
  icon: LucideIcon
  entityType: EntityType
}

const CAPTURE_TYPES: CaptureTypeOption[] = [
  { key: 'task', label: 'Task', icon: CheckSquare, entityType: 'task' },
  { key: 'note', label: 'Note', icon: NotebookPen, entityType: 'note' },
  { key: 'idea', label: 'Idea', icon: Lightbulb, entityType: 'note' },
  { key: 'goal', label: 'Goal', icon: Target, entityType: 'goal' },
  { key: 'habit', label: 'Habit', icon: Repeat, entityType: 'habit' },
]

function detectType(text: string): { type: CaptureType; extraTags: string[] } | null {
  const trimmed = text.trim()
  if (trimmed.startsWith('TODO ') || trimmed.startsWith('- [ ]')) {
    return { type: 'task', extraTags: [] }
  }
  if (trimmed.startsWith('?') || trimmed.endsWith('?')) {
    return { type: 'note', extraTags: ['question'] }
  }
  return null
}

function buildEntity(
  text: string,
  captureType: CaptureType,
  tags: string[],
  dueDate: string | undefined,
  ownerId: string,
) {
  const now = new Date().toISOString()
  const title = text.trim().replace(/^(TODO |- \[ \] )/, '').slice(0, 120) || 'Inbox item'

  const base = {
    id: crypto.randomUUID(),
    title,
    tags,
    ownerId,
    visibility: 'private' as const,
    createdAt: now,
    updatedAt: now,
    dueDate,
  }

  switch (captureType) {
    case 'task':
      return {
        ...base,
        type: 'task' as EntityType,
        status: 'todo' as EntityStatus,
        priority: 'medium' as EntityPriority,
        metadata: { body: text.trim(), isInbox: true },
      }
    case 'note':
      return {
        ...base,
        type: 'note' as EntityType,
        status: 'todo' as EntityStatus,
        priority: 'medium' as EntityPriority,
        metadata: { body: text.trim(), isInbox: true, isJournal: false },
      }
    case 'idea':
      return {
        ...base,
        type: 'note' as EntityType,
        status: 'todo' as EntityStatus,
        priority: 'medium' as EntityPriority,
        tags: [...tags.filter((t) => t !== 'idea'), 'idea'],
        metadata: { body: text.trim(), isInbox: true, isJournal: false },
      }
    case 'goal':
      return {
        ...base,
        type: 'goal' as EntityType,
        status: 'todo' as EntityStatus,
        priority: 'medium' as EntityPriority,
        metadata: { body: text.trim() },
      }
    case 'habit':
      return {
        ...base,
        type: 'habit' as EntityType,
        status: 'todo' as EntityStatus,
        priority: 'medium' as EntityPriority,
        metadata: { body: text.trim(), frequency: 'daily' },
      }
  }
}

export function InboxCapture() {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [captureType, setCaptureType] = useState<CaptureType>('note')
  const [tagsInput, setTagsInput] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [showDueDate, setShowDueDate] = useState(false)
  const [autoDetected, setAutoDetected] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const { create, items } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)

  const inboxCount = items.filter(
    (e) => e.metadata.isInbox === true && e.status === 'todo',
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

  // Reset form when dialog opens
  useEffect(() => {
    if (open) {
      setText('')
      setCaptureType('note')
      setTagsInput('')
      setDueDate('')
      setShowDueDate(false)
      setAutoDetected(false)
      // Focus textarea after dialog animation
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  }, [open])

  // Smart type detection
  useEffect(() => {
    const detected = detectType(text)
    if (detected) {
      setCaptureType(detected.type)
      setAutoDetected(true)
      if (detected.extraTags.length > 0) {
        setTagsInput((prev) => {
          const existing = prev
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean)
          const merged = [...new Set([...existing, ...detected.extraTags])]
          return merged.join(', ')
        })
      }
    } else if (autoDetected) {
      // If user clears the trigger text, reset to note
      setCaptureType('note')
      setAutoDetected(false)
    }
  }, [text, autoDetected])

  const handleSave = useCallback(() => {
    if (!text.trim()) return

    const userTags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const tags = [...new Set(['inbox', ...userTags])]
    const due = dueDate || undefined

    const entity = buildEntity(text, captureType, tags, due, currentUser?.id ?? '')
    create.mutate(entity)

    setOpen(false)

    const typeOption = CAPTURE_TYPES.find((t) => t.key === captureType)
    notify({
      title: `Captured! (${typeOption?.label ?? captureType})`,
      type: 'success',
    })
  }, [text, captureType, tagsInput, dueDate, create, currentUser])

  // Enter to save, Shift+Enter for newline
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSave()
    }
  }

  const activeOption = CAPTURE_TYPES.find((t) => t.key === captureType)!

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
        <DialogContent className="max-w-lg p-0 gap-0 overflow-hidden">
          <DialogHeader className="px-4 pt-4 pb-2">
            <DialogTitle className="text-sm font-medium text-muted-foreground">
              Quick Capture
            </DialogTitle>
          </DialogHeader>

          {/* Main text input */}
          <div className="px-4">
            <Textarea
              ref={textareaRef}
              placeholder="What's on your mind? (Enter to save)"
              rows={3}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={handleKeyDown}
              className="border-0 shadow-none focus-visible:ring-0 resize-none text-base p-0 placeholder:text-muted-foreground/50"
              autoFocus
            />
          </div>

          {/* Type picker row */}
          <div className="px-4 py-2 flex items-center gap-1.5 flex-wrap">
            {CAPTURE_TYPES.map((opt) => {
              const Icon = opt.icon
              const isActive = captureType === opt.key
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => {
                    setCaptureType(opt.key)
                    setAutoDetected(false)
                    // Show due date picker when switching to task
                    if (opt.key === 'task') setShowDueDate(true)
                    if (opt.key !== 'task') {
                      setShowDueDate(false)
                      setDueDate('')
                    }
                  }}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground hover:bg-muted/80'
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {opt.label}
                </button>
              )
            })}
          </div>

          {/* Options row: due date + tags */}
          <div className="px-4 pb-3 flex items-center gap-2 flex-wrap">
            {/* Due date (only for Task) */}
            {captureType === 'task' && (
              <Popover open={showDueDate} onOpenChange={setShowDueDate}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className={`inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs transition-colors ${
                      dueDate
                        ? 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400'
                        : 'bg-muted text-muted-foreground hover:bg-muted/80'
                    }`}
                  >
                    <CalendarIcon className="h-3.5 w-3.5" />
                    {dueDate || 'Due date'}
                    {dueDate && (
                      <X
                        className="h-3 w-3 ml-0.5 hover:text-destructive"
                        onClick={(e) => {
                          e.stopPropagation()
                          setDueDate('')
                        }}
                      />
                    )}
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-3" align="start">
                  <Input
                    type="date"
                    value={dueDate}
                    onChange={(e) => {
                      setDueDate(e.target.value)
                      setShowDueDate(false)
                    }}
                    className="text-sm"
                    autoFocus
                  />
                </PopoverContent>
              </Popover>
            )}

            {/* Tags input */}
            <div className="flex-1 min-w-[120px]">
              <Input
                type="text"
                placeholder="Tags (comma-separated)"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    handleSave()
                  }
                }}
                className="h-7 text-xs border-dashed"
              />
            </div>
          </div>

          {/* Footer */}
          <div className="px-4 py-2.5 border-t bg-muted/30 flex items-center justify-between">
            <span className="text-[11px] text-muted-foreground">
              <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">Enter</kbd> save
              {' '}<kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">Shift+Enter</kbd> newline
            </span>
            <Button
              size="sm"
              disabled={!text.trim()}
              onClick={handleSave}
              className="h-7 text-xs px-3"
            >
              <activeOption.icon className="h-3.5 w-3.5 mr-1" />
              Capture
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
