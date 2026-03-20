import { useState, useEffect, useCallback, useRef } from 'react'
import {
  Plus,
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
import { useUiStore } from '@/stores/ui-store'
import { notify } from '@/lib/notify'
import { CAPTURE_RULES, parseCapture, type CaptureRule } from '@/core/config/capture-protocol'
import type { EntityType, EntityStatus, EntityPriority } from '@/core/types'

// Default note rule for when no prefix matches
function buildEntity(
  text: string,
  rule: CaptureRule,
  tags: string[],
  dueDate: string | undefined,
  ownerId: string,
) {
  const now = new Date().toISOString()
  const title = text.trim().slice(0, 120) || 'Inbox item'

  return {
    id: crypto.randomUUID(),
    type: rule.entityType as EntityType,
    title,
    status: 'todo' as EntityStatus,
    priority: rule.defaultPriority as EntityPriority,
    tags: [...new Set([...tags, ...rule.autoTags])],
    metadata: {
      body: text.trim(),
      isInbox: true,
      ...(rule.entityType === 'note' ? { isJournal: false } : {}),
      ...(rule.entityType === 'habit' ? { frequency: 'daily' } : {}),
    },
    ownerId,
    visibility: 'private' as const,
    createdAt: now,
    updatedAt: now,
    dueDate,
  }
}

export function InboxCapture() {
  const open = useUiStore((s) => s.captureOpen)
  const setOpen = useUiStore((s) => s.setCaptureOpen)
  const [text, setText] = useState('')
  const [activeRule, setActiveRule] = useState<CaptureRule>(CAPTURE_RULES[0])
  const [tagsInput, setTagsInput] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [showDueDate, setShowDueDate] = useState(false)
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
      setActiveRule(CAPTURE_RULES.find((r) => r.entityType === 'note' && r.autoTags.length === 0) ?? CAPTURE_RULES[0])
      setTagsInput('')
      setDueDate('')
      setShowDueDate(false)
      setTimeout(() => textareaRef.current?.focus(), 50)
    }
  }, [open])

  // Smart type detection from prefix
  useEffect(() => {
    const { rule } = parseCapture(text)
    if (rule.prefix) {
      setActiveRule(rule)
    }
  }, [text])

  const handleSave = useCallback(() => {
    if (!text.trim()) return

    const { cleanText } = parseCapture(text)
    const userTags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const tags = [...new Set(['inbox', ...userTags])]
    const due = dueDate || undefined

    const entity = buildEntity(cleanText || text.trim(), activeRule, tags, due, currentUser?.id ?? '')
    create.mutate(entity)

    setOpen(false)
    notify({ title: `Captured! (${activeRule.label})`, type: 'success' })
  }, [text, activeRule, tagsInput, dueDate, create, currentUser])

  // Enter to save, Shift+Enter for newline
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
        aria-label="Quick capture (⌘⇧I)"
        title="Quick Capture (⌘⇧I)"
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

          {/* Protocol hint */}
          <div className="px-4 py-1">
            <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50">
              {CAPTURE_RULES.map((r) => (
                <span key={r.prefix} className={activeRule.prefix === r.prefix ? 'text-primary font-medium' : ''}>
                  <span className="font-mono">{r.prefix}</span>{r.label.toLowerCase()}
                </span>
              ))}
            </div>
          </div>

          {/* Type picker row */}
          <div className="px-4 py-2 flex items-center gap-1.5 flex-wrap">
            {CAPTURE_RULES.map((rule) => {
              const Icon = rule.icon
              const isActive = activeRule.prefix === rule.prefix
              return (
                <button
                  key={rule.prefix}
                  type="button"
                  onClick={() => {
                    setActiveRule(rule)
                    if (rule.entityType === 'task') setShowDueDate(true)
                    if (rule.entityType !== 'task') {
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
                  {rule.label}
                </button>
              )
            })}
          </div>

          {/* Options row: due date + tags */}
          <div className="px-4 pb-3 flex items-center gap-2 flex-wrap">
            {activeRule.entityType === 'task' && (
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
              <kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">⌘⇧I</kbd> open
              {' '}<kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">Enter</kbd> save
              {' '}<kbd className="px-1 py-0.5 rounded bg-muted text-[10px] font-mono">Shift+Enter</kbd> newline
            </span>
            <Button
              size="sm"
              disabled={!text.trim()}
              onClick={handleSave}
              className="h-7 text-xs px-3"
            >
              <activeRule.icon className="h-3.5 w-3.5 mr-1" />
              Capture
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
