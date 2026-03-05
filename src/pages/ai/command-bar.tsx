import { useState, useEffect, useMemo, useCallback } from 'react'
import { useNavigate } from 'react-router'
import { Search, Sparkles, ArrowRight } from 'lucide-react'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useUiStore } from '@/stores/ui-store'
import { useAIStore } from '@/stores/ai-store'
import { useFullTextSearch } from '@/core/hooks'
import { modules } from '@/core/config/modules'
import { AIClient, gatherContext, buildSystemPrompt } from '@/core/ai'
import type { ChatCompletionMessage } from '@/core/types/ai'

interface SearchResult {
  id: string
  label: string
  description?: string
  category: string
  action: () => void
}

export function CommandBar() {
  const open = useUiStore((s) => s.commandBarOpen)
  const setOpen = useUiStore((s) => s.setCommandBarOpen)
  const config = useAIStore((s) => s.config)
  const isConfigured = useAIStore((s) => s.isConfigured)
  const navigate = useNavigate()

  const [query, setQuery] = useState('')
  const [aiResponse, setAiResponse] = useState('')
  const [aiLoading, setAiLoading] = useState(false)

  const isAIMode = query.startsWith('/ask ')
  const searchQuery = isAIMode ? '' : query
  const searchResults = useFullTextSearch(searchQuery)

  // Reset state when dialog closes
  useEffect(() => {
    if (!open) {
      setQuery('')
      setAiResponse('')
      setAiLoading(false)
    }
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

  // Filtered results
  const filteredResults = useMemo(() => {
    if (!query || isAIMode) return []
    const q = query.toLowerCase()
    const matchingNav = navResults.filter(
      (r) =>
        r.label.toLowerCase().includes(q) ||
        r.description?.toLowerCase().includes(q),
    )
    return [...matchingNav, ...entityResults]
  }, [query, isAIMode, navResults, entityResults])

  // Group results by category
  const groupedResults = useMemo(() => {
    const groups: Record<string, SearchResult[]> = {}
    for (const r of filteredResults) {
      ;(groups[r.category] ??= []).push(r)
    }
    return Object.entries(groups)
  }, [filteredResults])

  const handleAIQuery = useCallback(async () => {
    if (!isConfigured) return
    const prompt = query.slice(5).trim()
    if (!prompt) return

    setAiLoading(true)
    setAiResponse('')
    try {
      const context = await gatherContext()
      const systemPrompt = buildSystemPrompt(context)
      const messages: ChatCompletionMessage[] = [
        { role: 'system', content: systemPrompt },
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
        const response = await client.complete(messages)
        setAiResponse(response)
      }
    } catch (error) {
      setAiResponse(
        `Error: ${error instanceof Error ? error.message : 'Something went wrong'}`,
      )
    } finally {
      setAiLoading(false)
    }
  }, [query, config, isConfigured])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && isAIMode) {
      e.preventDefault()
      handleAIQuery()
    }
    if (e.key === 'Tab' && !isAIMode && !query.startsWith('/ask ')) {
      e.preventDefault()
      setQuery('/ask ')
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-lg p-0 gap-0">
        <div className="flex items-center gap-2 border-b px-3">
          {isAIMode ? (
            <Sparkles className="h-4 w-4 shrink-0 text-primary" />
          ) : (
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          )}
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search or press Tab for AI..."
            className="border-0 focus-visible:ring-0 h-12 text-sm"
            autoFocus
          />
        </div>

        <ScrollArea className="max-h-[300px]">
          {isAIMode ? (
            <div className="p-4">
              {aiLoading && !aiResponse && (
                <p className="text-sm text-muted-foreground animate-pulse">
                  Thinking...
                </p>
              )}
              {aiResponse && (
                <p className="text-sm whitespace-pre-wrap">{aiResponse}</p>
              )}
              {!aiLoading && !aiResponse && (
                <p className="text-sm text-muted-foreground">
                  Press Enter to ask AI. {!isConfigured && '(AI not configured)'}
                </p>
              )}
            </div>
          ) : query && groupedResults.length > 0 ? (
            <div className="py-2">
              {groupedResults.map(([category, results]) => (
                <div key={category}>
                  <p className="px-3 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                    {category}
                  </p>
                  {results.slice(0, 8).map((r) => (
                    <button
                      key={r.id}
                      onClick={r.action}
                      className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent transition-colors text-left"
                    >
                      <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate flex-1">{r.label}</span>
                    </button>
                  ))}
                </div>
              ))}
            </div>
          ) : query && !isAIMode ? (
            <div className="p-4 text-center">
              <p className="text-sm text-muted-foreground">No results found.</p>
              <p className="text-xs text-muted-foreground mt-1">
                Press Tab to ask AI instead.
              </p>
            </div>
          ) : null}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  )
}
