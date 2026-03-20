import { useState, useRef, useEffect, useCallback } from 'react'
import { CornerDownLeft } from 'lucide-react'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'
import {
  parseCapture,
  capturePlaceholder,
  filterSlashCommands,
  groupSlashCommands,
  type SlashCommand,
} from '@/core/config/capture-protocol'

interface CaptureBarProps {
  /** 'down' = dropdown below input (default), 'up' = dropup above input */
  direction?: 'down' | 'up'
  /** Disable the global '/' keyboard shortcut */
  noGlobalShortcut?: boolean
}

export function CaptureBar({ direction = 'down', noGlobalShortcut }: CaptureBarProps) {
  const [value, setValue] = useState('')
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [showSuggestions, setShowSuggestions] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const { create } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)

  // Global shortcut: / to focus capture bar
  useEffect(() => {
    if (noGlobalShortcut) return
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
  }, [noGlobalShortcut])

  const suggestions = filterSlashCommands(value.trim())
  const groups = groupSlashCommands(suggestions)
  const hasSuggestions = showSuggestions && suggestions.length > 0

  // Reset selected index when suggestions change
  useEffect(() => {
    setSelectedIdx(0)
  }, [suggestions.length])

  // Show/hide suggestions based on input
  useEffect(() => {
    const trimmed = value.trim()
    setShowSuggestions(trimmed.startsWith('/') && !trimmed.includes(' '))
  }, [value])

  const selectCommand = useCallback((cmd: SlashCommand) => {
    setValue(cmd.command + ' ')
    setShowSuggestions(false)
    inputRef.current?.focus()
  }, [])

  const parsed = parseCapture(value)

  const handleCapture = () => {
    const { rule, cleanText } = parsed
    if (!cleanText) return

    const now = new Date().toISOString()
    const tags = [...new Set(['inbox', ...rule.autoTags])]

    create.mutate({
      id: crypto.randomUUID(),
      type: rule.entityType,
      title: cleanText.slice(0, 120) || 'Inbox item',
      status: 'todo',
      priority: rule.defaultPriority,
      tags,
      metadata: { body: cleanText, isInbox: true, ...(rule.entityType === 'habit' ? { frequency: 'daily' } : {}) },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
      ...(rule.entityType === 'task' ? { dueDate: now.split('T')[0] } : {}),
    })

    setValue('')
    notify({ title: `${rule.label} captured`, type: 'success' })
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (hasSuggestions) {
      // In 'up' mode the visual list is reversed, so arrow keys are swapped
      const isUp = direction === 'up'
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (isUp) {
          setSelectedIdx((i) => Math.max(i - 1, 0))
        } else {
          setSelectedIdx((i) => Math.min(i + 1, suggestions.length - 1))
        }
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (isUp) {
          setSelectedIdx((i) => Math.min(i + 1, suggestions.length - 1))
        } else {
          setSelectedIdx((i) => Math.max(i - 1, 0))
        }
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        selectCommand(suggestions[selectedIdx])
        return
      }
    }

    if (e.key === 'Enter') {
      e.preventDefault()
      handleCapture()
    }
    if (e.key === 'Escape') {
      if (showSuggestions) {
        setShowSuggestions(false)
      } else {
        setValue('')
        inputRef.current?.blur()
      }
    }
  }

  // Scroll selected item into view
  useEffect(() => {
    if (!hasSuggestions || !listRef.current) return
    const el = listRef.current.querySelector(`[data-idx="${selectedIdx}"]`) as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx, hasSuggestions])

  // Position classes for suggestion panel
  const panelPosition = direction === 'up'
    ? 'bottom-full mb-1'
    : 'top-full mt-1'

  // For 'up' mode, reverse the group order so closest-to-input items are at bottom
  const displayGroups = direction === 'up' ? [...groups].reverse() : groups

  return (
    <div className="relative">
      <input
        ref={inputRef}
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={() => setTimeout(() => setShowSuggestions(false), 150)}
        onFocus={() => {
          if (value.trim().startsWith('/') && !value.trim().includes(' ')) {
            setShowSuggestions(true)
          }
        }}
        placeholder={capturePlaceholder()}
        className="w-full h-10 rounded-lg border bg-muted/30 px-4 pr-24 text-sm placeholder:text-muted-foreground/40 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:bg-background transition-colors"
      />

      {/* Slash command suggestions */}
      {hasSuggestions && (
        <div
          ref={listRef}
          className={`absolute left-0 right-0 ${panelPosition} max-h-[320px] overflow-y-auto rounded-lg border bg-popover shadow-lg z-50`}
        >
          {displayGroups.map((group) => {
            const groupCommands = direction === 'up' ? [...group.commands].reverse() : group.commands
            return (
              <div key={group.category}>
                <div className="sticky top-0 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/50 bg-popover/95 backdrop-blur-sm border-b border-border/30">
                  {group.label}
                </div>
                {groupCommands.map((cmd) => {
                  const cmdIdx = suggestions.indexOf(cmd)
                  const isSelected = cmdIdx === selectedIdx
                  return (
                    <button
                      key={cmd.command}
                      data-idx={cmdIdx}
                      type="button"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => selectCommand(cmd)}
                      onMouseEnter={() => setSelectedIdx(cmdIdx)}
                      className={`w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
                        isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'
                      }`}
                    >
                      <span className="text-base shrink-0 w-5 text-center">{cmd.emoji}</span>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs text-primary">{cmd.command}</span>
                          {cmd.aliases.length > 0 && (
                            <span className="text-[10px] text-muted-foreground/40 font-mono">
                              {cmd.aliases.join(' ')}
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] text-muted-foreground/60 truncate">{cmd.description}</p>
                      </div>
                      {isSelected && (
                        <kbd className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground/50 font-mono shrink-0">
                          ↵
                        </kbd>
                      )}
                    </button>
                  )
                })}
              </div>
            )
          })}
        </div>
      )}

      {/* Right side: type badge + submit */}
      {value && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
          {!hasSuggestions && (
            <span className="text-[10px] font-medium text-muted-foreground/60 bg-muted px-1.5 py-0.5 rounded">
              {parsed.rule.label}
            </span>
          )}
          <button
            onClick={handleCapture}
            className="p-1.5 rounded-md hover:bg-muted transition-colors"
          >
            <CornerDownLeft className="h-3.5 w-3.5 text-muted-foreground" />
          </button>
        </div>
      )}
    </div>
  )
}
