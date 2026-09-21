/**
 * ⌘K — the one place you type at Lyra.
 *
 * There used to be three. A global capture dialog on ⌘⇧I, a capture bar that stole `/` on two
 * pages, and this palette: three inputs, three shortcuts, three placeholders, and a decision to
 * make before writing anything down. Capture is the thing you do most and the thing that most
 * needs to cost nothing, so it moved to the shortcut that is already in your fingers.
 *
 * # One input, three modes, chosen by the first character
 *
 * - **plain text** → find something. Modules and entities, ranked.
 * - **a prefix** (`/`, `!`, `?`, `*`, `@`, `#`) → make something. The capture protocol parses it;
 *   see [[parseCapture]].
 * - **`/ask`** → ask Lyra about your own data.
 *
 * The rule is "a prefix means create, bare text means find", which is one thing to remember rather
 * than three. `/ask` is reserved ahead of the capture protocol so a question can never be filed as
 * a note by accident.
 *
 * Capture leaves the palette open and clears the field. Thoughts arrive in bursts, and a dialog
 * that closes after one of them makes you pay the open cost again for the second.
 */

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router'
import { Search, Sparkles, ArrowRight, CornerDownLeft } from 'lucide-react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useUiStore } from '@/stores/ui-store'
import { useAIStore } from '@/stores/ai-store'
import { useAuthStore } from '@/stores/auth-store'
import { useEntities, useFullTextSearch } from '@/core/hooks'
import { modules } from '@/core/config/modules'
import { AIClient, gatherContext, buildSystemPrompt } from '@/core/ai'
import {
  CapturePrefix,
  filterSlashCommands,
  groupSlashCommands,
  parseCapture,
  type SlashCommand,
} from '@/core/config/capture-protocol'
import type { ChatCompletionMessage } from '@/core/types/ai'

interface SearchResult {
  id: string
  label: string
  description?: string
  category: string
  action: () => void
}

/**
 * First characters that mean "create", not "find".
 *
 * Read from the capture protocol rather than written out again, so adding a prefix there cannot
 * leave the palette treating it as a search term.
 */
const CAPTURE_TRIGGERS = ['/', ...Object.values(CapturePrefix)]

/** `/ask` is the palette's own command, not a capture rule — it makes nothing. */
const ASK = '/ask'

type Suggestion = { kind: 'ask' } | { kind: 'slash'; cmd: SlashCommand }

export function CommandBar() {
  const open = useUiStore((s) => s.commandBarOpen)
  const setOpen = useUiStore((s) => s.setCommandBarOpen)
  const seed = useUiStore((s) => s.commandBarSeed)
  const config = useAIStore((s) => s.config)
  const isConfigured = useAIStore((s) => s.isConfigured)
  const currentUser = useAuthStore((s) => s.currentUser)
  const { create } = useEntities()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)

  const [query, setQuery] = useState('')
  const [aiResponse, setAiResponse] = useState('')
  const [aiLoading, setAiLoading] = useState(false)
  const [captured, setCaptured] = useState<string | null>(null)
  const [cursor, setCursor] = useState(0)

  const trimmed = query.trim()
  const isAIMode = trimmed.toLowerCase().startsWith(ASK)
  const isCaptureMode = !isAIMode && CAPTURE_TRIGGERS.some((p) => trimmed.startsWith(p))

  const searchResults = useFullTextSearch(isAIMode || isCaptureMode ? '' : query)

  useEffect(() => {
    if (open) {
      // A shortcut can ask for a mode by seeding the field — ⌘⇧I still means capture, it just
      // opens this palette with a `/` in it rather than a dialog of its own.
      setQuery(seed)
      useUiStore.setState({ commandBarSeed: '' })
    } else {
      setQuery('')
      setAiResponse('')
      setAiLoading(false)
      setCaptured(null)
    }
    // `seed` is read once per open, deliberately: re-running when it clears would wipe the field
    // out from under the first keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // Navigation results
  const navResults: SearchResult[] = useMemo(
    () =>
      modules.map((m) => ({
        id: `nav-${m.id}`,
        label: m.label,
        description: `Go to ${m.label}`,
        category: 'Navigation',
        action: () => {
          navigate(m.path)
          setOpen(false)
        },
      })),
    [navigate, setOpen],
  )

  // Entity results from full-text search
  const entityResults: SearchResult[] = useMemo(
    () =>
      searchResults.map((e) => ({
        id: `entity-${e.id}`,
        label: e.title,
        description: e.description,
        category: e.type.charAt(0).toUpperCase() + e.type.slice(1) + 's',
        action: () => {
          const mod = modules.find((m) => m.entityTypes.includes(e.type))
          if (mod) navigate(mod.path)
          setOpen(false)
        },
      })),
    [searchResults, navigate, setOpen],
  )

  const filteredResults = useMemo(() => {
    if (!query || isAIMode || isCaptureMode) return []
    const q = query.toLowerCase()
    const matchingNav = navResults.filter(
      (r) => r.label.toLowerCase().includes(q) || r.description?.toLowerCase().includes(q),
    )
    return [...matchingNav, ...entityResults]
  }, [query, isAIMode, isCaptureMode, navResults, entityResults])

  const groupedResults = useMemo(() => {
    const groups: Record<string, SearchResult[]> = {}
    for (const r of filteredResults) {
      ;(groups[r.category] ??= []).push(r)
    }
    return Object.entries(groups)
  }, [filteredResults])

  /**
   * The slash menu, offered while the command is still being typed.
   *
   * It closes as soon as there is a space, because from that point the rest of the line is the
   * thing being captured rather than a command being chosen.
   */
  const suggestions: Suggestion[] = useMemo(() => {
    // The space is checked on the raw text, not the trimmed text. `'/ask '.trim()` has no space
    // in it, so trimming first kept the menu open over the AI panel the space had just opened.
    const typing = query.trimStart()
    if (!typing.startsWith('/') || typing.includes(' ')) return []
    const list: Suggestion[] = ASK.startsWith(trimmed.toLowerCase()) ? [{ kind: 'ask' }] : []
    return [...list, ...filterSlashCommands(trimmed).map((cmd) => ({ kind: 'slash' as const, cmd }))]
  }, [query, trimmed])

  // The keyboard walks whichever list is on screen, so the palette is usable without the mouse in
  // every mode rather than only in the slash menu.
  const flatResults = useMemo(() => groupedResults.flatMap(([, rows]) => rows), [groupedResults])
  const cursorMax = (suggestions.length || flatResults.length) - 1

  useEffect(() => {
    setCursor(0)
  }, [trimmed])

  const pickSuggestion = useCallback((s: Suggestion) => {
    setQuery(s.kind === 'ask' ? `${ASK} ` : `${s.cmd.command} `)
    inputRef.current?.focus()
  }, [])

  const handleCapture = useCallback(() => {
    const { rule, cleanText } = parseCapture(query)
    if (!cleanText) return

    const now = new Date().toISOString()
    create.mutate({
      id: crypto.randomUUID(),
      type: rule.entityType,
      title: cleanText.slice(0, 120),
      status: 'todo',
      priority: rule.defaultPriority,
      tags: [...new Set(['inbox', ...rule.autoTags])],
      metadata: {
        body: cleanText,
        isInbox: true,
        ...(rule.entityType === 'habit' ? { frequency: 'daily' } : {}),
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: now,
      updatedAt: now,
      ...(rule.entityType === 'task' ? { dueDate: now.split('T')[0] } : {}),
    })

    // Confirmation in place of a toast: the palette is still open and covering the screen, so a
    // notification behind it would be a confirmation you cannot see.
    setCaptured(`${rule.label} · ${cleanText.slice(0, 60)}`)
    setQuery('')
  }, [query, create, currentUser])

  const handleAIQuery = useCallback(async () => {
    if (!isConfigured) return
    const prompt = trimmed.slice(ASK.length).trim()
    if (!prompt) return

    setAiLoading(true)
    setAiResponse('')
    try {
      const context = await gatherContext()
      const messages: ChatCompletionMessage[] = [
        { role: 'system', content: buildSystemPrompt(context) },
        { role: 'user', content: prompt },
      ]
      const client = new AIClient(config)

      try {
        let accumulated = ''
        for await (const chunk of client.stream(messages)) {
          accumulated += chunk
          setAiResponse(accumulated)
        }
      } catch {
        setAiResponse(await client.complete(messages))
      }
    } catch (error) {
      setAiResponse(`Error: ${error instanceof Error ? error.message : 'Something went wrong'}`)
    } finally {
      setAiLoading(false)
    }
  }, [trimmed, config, isConfigured])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' && cursorMax >= 0) {
      e.preventDefault()
      setCursor((i) => Math.min(i + 1, cursorMax))
      return
    }
    if (e.key === 'ArrowUp' && cursorMax >= 0) {
      e.preventDefault()
      setCursor((i) => Math.max(i - 1, 0))
      return
    }
    if (e.key !== 'Enter') return

    e.preventDefault()
    if (suggestions.length > 0) {
      pickSuggestion(suggestions[cursor])
    } else if (isAIMode) {
      handleAIQuery()
    } else if (isCaptureMode) {
      handleCapture()
    } else {
      flatResults[cursor]?.action()
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="gap-0 p-0 sm:max-w-lg">
        {/* The palette is its own label; a visible heading would push the input off the first
            line for no reader who does not already know what ⌘K opened. */}
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex items-center gap-2 border-b px-3">
          {isAIMode ? (
            <Sparkles className="size-4 shrink-0 text-primary" />
          ) : isCaptureMode ? (
            <CornerDownLeft className="size-4 shrink-0 text-primary" />
          ) : (
            <Search className="size-4 shrink-0 text-muted-foreground" />
          )}
          <Input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search, or / ! @ # to capture"
            className="h-12 border-0 text-sm focus-visible:ring-0"
            autoFocus
          />
          {/* What Enter will do, before it is pressed — the whole point of a prefixed mode is
              lost if you cannot tell which one you are in. */}
          {isCaptureMode && suggestions.length === 0 && (
            <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {parseCapture(query).rule.label}
            </span>
          )}
        </div>

        <ScrollArea className="max-h-[320px]">
          {suggestions.length > 0 ? (
            <SlashMenu suggestions={suggestions} cursor={cursor} onPick={pickSuggestion} />
          ) : isAIMode ? (
            <div className="p-4">
              {aiLoading && !aiResponse && (
                <p className="animate-pulse text-sm text-muted-foreground">Thinking…</p>
              )}
              {aiResponse && <p className="text-sm whitespace-pre-wrap">{aiResponse}</p>}
              {!aiLoading && !aiResponse && (
                <p className="text-sm text-muted-foreground">
                  Press Enter to ask Lyra. {!isConfigured && '(AI not configured)'}
                </p>
              )}
            </div>
          ) : isCaptureMode ? (
            <div className="p-4 text-sm text-muted-foreground">
              Enter to capture as <span className="font-medium text-foreground">{parseCapture(query).rule.label}</span>
              {' · '}Esc to close
            </div>
          ) : groupedResults.length > 0 ? (
            <ResultList groups={groupedResults} cursor={cursor} flat={flatResults} />
          ) : query ? (
            <div className="p-4 text-center">
              <p className="text-sm text-muted-foreground">No results found.</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Start with <kbd className="font-mono">/</kbd> to capture it instead.
              </p>
            </div>
          ) : (
            <Hints />
          )}
        </ScrollArea>

        {captured && (
          <p className="border-t px-3 py-2 text-xs text-muted-foreground">
            Captured — <span className="text-foreground">{captured}</span>
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** The empty state, which is where the prefixes get taught. */
function Hints() {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 p-4 text-xs text-muted-foreground">
      {[
        ['type', 'search everything'],
        ['/', 'pick a capture command'],
        ['!', 'a task'],
        ['@', 'a goal'],
        ['#', 'a habit'],
        ['/ask', 'ask Lyra about your data'],
      ].map(([key, what]) => (
        <div key={key} className="contents">
          <dt className="text-right font-mono text-foreground">{key}</dt>
          <dd>{what}</dd>
        </div>
      ))}
    </dl>
  )
}

function SlashMenu({
  suggestions,
  cursor,
  onPick,
}: {
  suggestions: Suggestion[]
  cursor: number
  onPick: (s: Suggestion) => void
}) {
  const ask = suggestions.find((s) => s.kind === 'ask')
  const slashes = suggestions.filter((s): s is { kind: 'slash'; cmd: SlashCommand } => s.kind === 'slash')
  const groups = groupSlashCommands(slashes.map((s) => s.cmd))

  return (
    <div className="py-1">
      {ask && (
        <Row
          selected={cursor === 0}
          onPick={() => onPick(ask)}
          emoji="✨"
          command={ASK}
          description="Ask Lyra about your own data"
        />
      )}
      {groups.map((group) => (
        <div key={group.category}>
          <p className="px-3 py-1.5 text-[10px] font-semibold tracking-wider text-muted-foreground/60 uppercase">
            {group.label}
          </p>
          {group.commands.map((cmd) => {
            const index = suggestions.findIndex((s) => s.kind === 'slash' && s.cmd === cmd)
            return (
              <Row
                key={cmd.command}
                selected={cursor === index}
                onPick={() => onPick({ kind: 'slash', cmd })}
                emoji={cmd.emoji}
                command={cmd.command}
                aliases={cmd.aliases}
                description={cmd.description}
              />
            )
          })}
        </div>
      ))}
    </div>
  )
}

function Row({
  selected,
  onPick,
  emoji,
  command,
  aliases = [],
  description,
}: {
  selected: boolean
  onPick: () => void
  emoji: string
  command: string
  aliases?: string[]
  description: string
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onPick}
      className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
        selected ? 'bg-accent text-accent-foreground' : 'hover:bg-muted/50'
      }`}
    >
      <span className="w-5 shrink-0 text-center text-base">{emoji}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-mono text-xs text-primary">{command}</span>
          {aliases.length > 0 && (
            <span className="font-mono text-[10px] text-muted-foreground/50">{aliases.join(' ')}</span>
          )}
        </div>
        <p className="truncate text-[11px] text-muted-foreground/70">{description}</p>
      </div>
    </button>
  )
}

function ResultList({
  groups,
  cursor,
  flat,
}: {
  groups: [string, SearchResult[]][]
  cursor: number
  flat: SearchResult[]
}) {
  return (
    <div className="py-2">
      {groups.map(([category, results]) => (
        <div key={category}>
          <p className="px-3 py-1.5 text-[10px] font-medium tracking-wider text-muted-foreground uppercase">
            {category}
          </p>
          {results.map((r) => (
            <button
              key={r.id}
              onClick={r.action}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors ${
                flat[cursor]?.id === r.id ? 'bg-accent text-accent-foreground' : 'hover:bg-accent'
              }`}
            >
              <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate">{r.label}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  )
}
