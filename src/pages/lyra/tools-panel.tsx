import { useState, useCallback } from 'react'
import { Sparkles, ChevronDown, ChevronRight, Settings, Zap } from 'lucide-react'
import { LyraLoader } from '@/components/lyra-loader'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAI } from '@/hooks/use-ai'
import { useAIStore } from '@/stores/ai-store'
import { useEntities } from '@/core/hooks'
import { getAllTools } from '@/core/ai/tools'
import { AISettingsDialog } from '@/pages/ai/ai-settings-dialog'

interface ToolsPanelProps {
  settingsOpen: boolean
  onSettingsOpenChange: (open: boolean) => void
}

interface ToolResultEntry {
  text: string
  loading: boolean
  expanded: boolean
}

const CACHE_PREFIX = 'lyra:tool-result'

function getCachedResult(toolId: string, entityId?: string): string | null {
  const key = `${CACHE_PREFIX}:${toolId}:${entityId ?? 'global'}`
  return sessionStorage.getItem(key)
}

function setCachedResult(toolId: string, result: string, entityId?: string) {
  const key = `${CACHE_PREFIX}:${toolId}:${entityId ?? 'global'}`
  sessionStorage.setItem(key, result)
}

export function ToolsPanel({ settingsOpen, onSettingsOpenChange }: ToolsPanelProps) {
  const { run, isOnline, modelName } = useAI()
  const config = useAIStore((s) => s.config)
  const { items: entities } = useEntities()
  const tools = getAllTools()

  const [results, setResults] = useState<Record<string, ToolResultEntry>>({})
  const [selectedEntities, setSelectedEntities] = useState<Record<string, string>>({})

  const getResultKey = (toolId: string, entityId?: string) =>
    `${toolId}:${entityId ?? 'global'}`

  const handleRun = useCallback(
    async (toolId: string, entityId?: string) => {
      const key = getResultKey(toolId, entityId)

      // Check cache first
      const cached = getCachedResult(toolId, entityId)
      if (cached) {
        setResults((prev) => ({
          ...prev,
          [key]: { text: cached, loading: false, expanded: true },
        }))
        return
      }

      setResults((prev) => ({
        ...prev,
        [key]: { text: '', loading: true, expanded: true },
      }))

      try {
        const result = await run(toolId, entityId)
        setCachedResult(toolId, result, entityId)
        setResults((prev) => ({
          ...prev,
          [key]: { text: result, loading: false, expanded: true },
        }))
      } catch {
        setResults((prev) => ({
          ...prev,
          [key]: { text: 'Failed to execute tool.', loading: false, expanded: true },
        }))
      }
    },
    [run],
  )

  const toggleExpanded = (key: string) => {
    setResults((prev) => {
      const entry = prev[key]
      if (!entry) return prev
      return { ...prev, [key]: { ...entry, expanded: !entry.expanded } }
    })
  }

  return (
    <div className="w-80 border-l border-border/40 flex flex-col bg-card/30">
      {/* Header */}
      <div className="px-4 py-3 border-b border-border/40">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
          <Zap className="h-3.5 w-3.5" />
          Arsenal
        </p>
      </div>

      {/* Tool cards */}
      <div className="flex-1 overflow-y-auto scrollbar-thin px-3 py-3 space-y-2.5">
        {tools.map((tool) => {
          const isGlobal = tool.scope === 'global'
          const selectedEntity = selectedEntities[tool.id]
          const resultKey = getResultKey(tool.id, isGlobal ? undefined : selectedEntity)
          const result = results[resultKey]

          // Filter entities matching tool scope
          const scopeEntities = !isGlobal
            ? entities.filter((e) => (tool.scope as string[]).includes(e.type))
            : []

          return (
            <Card key={tool.id} className="p-3 bg-card/50 border-border/30 space-y-2">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium truncate">{tool.name}</p>
                  <p className="text-[11px] text-muted-foreground line-clamp-2">
                    {tool.description}
                  </p>
                </div>
                <Badge
                  variant="secondary"
                  className="shrink-0 text-[9px] px-1.5 py-0 font-mono"
                >
                  {isGlobal ? 'Global' : (tool.scope as string[]).join(', ')}
                </Badge>
              </div>

              {/* Entity selector for scoped tools */}
              {!isGlobal && (
                <Select
                  value={selectedEntity ?? ''}
                  onValueChange={(val) =>
                    setSelectedEntities((prev) => ({ ...prev, [tool.id]: val }))
                  }
                >
                  <SelectTrigger className="h-7 text-[11px]">
                    <SelectValue placeholder="Select entity..." />
                  </SelectTrigger>
                  <SelectContent>
                    {scopeEntities.map((entity) => (
                      <SelectItem key={entity.id} value={entity.id} className="text-xs">
                        {entity.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}

              <Button
                variant="outline"
                size="sm"
                className="w-full h-7 text-[11px] font-mono"
                disabled={
                  result?.loading ||
                  !isOnline ||
                  (!isGlobal && !selectedEntity)
                }
                onClick={() => handleRun(tool.id, isGlobal ? undefined : selectedEntity)}
              >
                {result?.loading ? (
                  <LyraLoader size={20} />
                ) : (
                  <Sparkles className="h-3 w-3 mr-1" />
                )}
                Run
              </Button>

              {/* Result area */}
              {result && !result.loading && result.text && (
                <div className="rounded-md bg-primary/5 border border-primary/10">
                  <button
                    className="w-full flex items-center gap-1 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground"
                    onClick={() => toggleExpanded(resultKey)}
                  >
                    {result.expanded ? (
                      <ChevronDown className="h-3 w-3" />
                    ) : (
                      <ChevronRight className="h-3 w-3" />
                    )}
                    Result
                  </button>
                  {result.expanded && (
                    <div className="px-2 pb-2">
                      <p className="text-xs text-foreground/80 whitespace-pre-wrap break-words">
                        {result.text}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </Card>
          )
        })}
      </div>

      {/* Bottom: Settings summary */}
      <div className="border-t border-border/40 px-4 py-3 space-y-2">
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-muted-foreground">provider</span>
            <span className="text-[10px] font-mono text-foreground/80">{config.provider}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-muted-foreground">model</span>
            <span className="text-[10px] font-mono text-foreground/80 truncate ml-2">
              {modelName ?? config.model}
            </span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-muted-foreground">status</span>
            <span
              className={`text-[10px] font-mono ${isOnline ? 'text-emerald-500' : 'text-muted-foreground/30'}`}
            >
              {isOnline ? 'operational' : 'offline'}
            </span>
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="w-full h-7 text-[11px]"
          onClick={() => onSettingsOpenChange(true)}
        >
          <Settings className="h-3 w-3 mr-1.5" />
          Configure
        </Button>
      </div>

      <AISettingsDialog open={settingsOpen} onOpenChange={onSettingsOpenChange} />
    </div>
  )
}
