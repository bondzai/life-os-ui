import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import {
  Plus,
  CalendarIcon,
  X,
  Sparkles,
} from 'lucide-react'
import { LyraLoader } from '@/components/lyra-loader'
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
import { Badge } from '@/components/ui/badge'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { useUiStore } from '@/stores/ui-store'
import { useAIStore } from '@/stores/ai-store'
import { notify } from '@/lib/notify'
import { CAPTURE_RULES, parseCapture, type CaptureRule } from '@/core/config/capture-protocol'
import { AIClient } from '@/core/ai/ai-client'
import { getTool } from '@/core/ai/tools'
import { useAI } from '@/hooks/use-ai'
import type { EntityType, EntityStatus, EntityPriority } from '@/core/types'

interface AIParsedCapture {
  type: string
  title: string
  priority: string
  dueDate: string | null
  projectId: string | null
  goalId: string | null
  tags: string[]
  subtasks: string[]
}

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
  const { isOnline } = useAI()
  const config = useAIStore((s) => s.config)

  const [aiParsed, setAiParsed] = useState<AIParsedCapture | null>(null)
  const [aiLoading, setAiLoading] = useState(false)
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined)

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
      setAiParsed(null)
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

  // AI parsing: debounce natural language input
  useEffect(() => {
    if (!isOnline || text.length < 10) {
      setAiParsed(null)
      return
    }

    const { rule } = parseCapture(text)
    // If prefix matched, skip AI (fast path)
    if (rule.prefix) {
      setAiParsed(null)
      return
    }

    clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(async () => {
      setAiLoading(true)
      try {
        const parseTool = getTool('parse-capture')
        if (!parseTool) return
        const messages = parseTool.buildPrompt({ entities: items, trackers: [] })
        // Replace placeholder user message with actual text
        messages[messages.length - 1] = { role: 'user', content: text }

        const fallbackConfig = {
          provider: 'ollama' as const,
          endpoint: 'http://localhost:11434/v1',
          model: 'llama3.2:1b',
          apiKey: '',
          contextWindow: 8192,
        }
        const resolvedConfig = config.endpoint && config.model ? config : fallbackConfig
        const client = new AIClient(resolvedConfig)
        const response = await client.complete(messages)

        // Parse JSON from response
        const jsonMatch = response.match(/\{[\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]) as AIParsedCapture
          setAiParsed(parsed)
          // Auto-update active rule based on parsed type
          const matchedRule = CAPTURE_RULES.find((r) => r.entityType === parsed.type)
          if (matchedRule) setActiveRule(matchedRule)
          if (parsed.dueDate) setDueDate(parsed.dueDate)
          if (parsed.tags?.length) setTagsInput(parsed.tags.join(', '))
        }
      } catch {
        /* silent */
      } finally {
        setAiLoading(false)
      }
    }, 800)

    return () => clearTimeout(debounceRef.current)
  }, [text, isOnline, items, config])

  // Duplicate detection
  const duplicate = useMemo(() => {
    if (!aiParsed) return null
    const title = aiParsed.title.toLowerCase()
    return items.find(
      (e) =>
        e.status !== 'archived' &&
        (e.title.toLowerCase().includes(title.slice(0, 20)) ||
          title.includes(e.title.toLowerCase().slice(0, 20))),
    ) ?? null
  }, [aiParsed, items])

  const handleSave = useCallback(() => {
    if (!text.trim()) return

    const { cleanText } = parseCapture(text)
    const userTags = tagsInput
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean)
    const tags = [...new Set(['inbox', ...userTags, ...(aiParsed?.tags ?? [])])]
    const due = dueDate || aiParsed?.dueDate || undefined

    const entity = buildEntity(
      aiParsed?.title || cleanText || text.trim(),
      activeRule,
      tags,
      due,
      currentUser?.id ?? '',
    )

    // Add AI-parsed metadata
    if (aiParsed) {
      entity.metadata = {
        ...entity.metadata,
        ...(aiParsed.projectId ? { projectId: aiParsed.projectId } : {}),
        ...(aiParsed.goalId ? { goalId: aiParsed.goalId } : {}),
        ...(aiParsed.subtasks.length > 0
          ? {
              isStory: true,
              subtasks: aiParsed.subtasks.map((s) => ({
                id: crypto.randomUUID(),
                title: s,
                done: false,
                status: 'todo' as const,
              })),
            }
          : {}),
      }
      if (aiParsed.priority) {
        entity.priority = aiParsed.priority as EntityPriority
      }
    }

    create.mutate(entity)

    setOpen(false)
    setAiParsed(null)
    notify({ title: `Captured! (${activeRule.label})`, type: 'success' })
  }, [text, activeRule, tagsInput, dueDate, create, currentUser, aiParsed])

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

          {/* AI Parse Preview */}
          {aiLoading && (
            <div className="px-4 py-2">
              <LyraLoader size={16} label="Parsing..." />
            </div>
          )}

          {aiParsed && !aiLoading && (
            <div className="mx-4 mb-2 p-2.5 rounded-md bg-primary/5 border border-primary/10 space-y-1.5">
              <div className="flex items-center gap-1.5">
                <Sparkles className="h-3 w-3 text-primary" />
                <span className="text-[10px] font-medium text-primary">Lyra understood</span>
              </div>
              <div className="flex flex-wrap gap-1.5">
                <Badge variant="secondary" className="text-[10px]">
                  {aiParsed.type}
                </Badge>
                {aiParsed.priority !== 'medium' && (
                  <Badge
                    variant={aiParsed.priority === 'urgent' ? 'destructive' : 'default'}
                    className="text-[10px]"
                  >
                    {aiParsed.priority}
                  </Badge>
                )}
                {aiParsed.dueDate && (
                  <Badge variant="outline" className="text-[10px]">
                    Due: {aiParsed.dueDate}
                  </Badge>
                )}
                {aiParsed.projectId && (
                  <Badge variant="outline" className="text-[10px]">
                    Project: {items.find((e) => e.id === aiParsed.projectId)?.title ?? 'linked'}
                  </Badge>
                )}
              </div>
              <p className="text-xs font-medium">{aiParsed.title}</p>
              {aiParsed.subtasks.length > 0 && (
                <div className="text-[10px] text-muted-foreground">
                  {aiParsed.subtasks.length} subtasks suggested
                </div>
              )}
              {duplicate && (
                <div className="text-[10px] text-amber-500">
                  Similar item exists: &quot;{duplicate.title}&quot;
                </div>
              )}
            </div>
          )}

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
