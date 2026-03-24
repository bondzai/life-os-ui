import { useState } from 'react'
import { Wifi, WifiOff } from 'lucide-react'
import { LyraLoader } from '@/components/lyra-loader'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useAI } from '@/hooks/use-ai'
import { getAllTools } from '@/core/ai/tools'

export function StrategicDashboard() {
  const { run, isOnline, modelName } = useAI()
  const [toolResult, setToolResult] = useState<{ toolId: string; text: string } | null>(null)
  const [toolRunning, setToolRunning] = useState<string | null>(null)

  const tools = getAllTools()

  const handleToolClick = async (toolId: string, scope: string[] | 'global') => {
    if (scope !== 'global') return
    setToolRunning(toolId)
    try {
      const result = await run(toolId)
      setToolResult({ toolId, text: result })
    } catch {
      setToolResult({ toolId, text: 'Failed to run tool.' })
    } finally {
      setToolRunning(null)
    }
  }

  return (
    <div className="border-b border-border/40 bg-card/30 px-4 py-3 space-y-2">
      <div className="flex items-start gap-6">
        {/* Status */}
        <div className="flex items-center gap-2">
          {isOnline ? (
            <Wifi className="h-3.5 w-3.5 text-emerald-500" />
          ) : (
            <WifiOff className="h-3.5 w-3.5 text-muted-foreground/30" />
          )}
          <span className="font-mono text-[11px] text-muted-foreground">
            {modelName ?? 'disconnected'}
          </span>
          <span
            className={`text-[10px] font-mono ${isOnline ? 'text-emerald-500' : 'text-muted-foreground/30'}`}
          >
            {isOnline ? 'online' : 'offline'}
          </span>
        </div>

        {/* Quick Action Chips */}
        <div className="flex flex-wrap gap-1.5">
          {tools.map((tool) => (
            <Button
              key={tool.id}
              variant="outline"
              size="sm"
              className="h-6 px-2 text-[11px] font-mono"
              disabled={toolRunning === tool.id}
              onClick={() => handleToolClick(tool.id, tool.scope)}
            >
              {toolRunning === tool.id ? (
                <LyraLoader size={20} />
              ) : null}
              {tool.name}
              {tool.scope !== 'global' && (
                <Badge variant="secondary" className="ml-1 text-[9px] px-1 py-0">
                  select entity
                </Badge>
              )}
            </Button>
          ))}
        </div>
      </div>

      {/* Collapsible tool result */}
      {toolResult && (
        <div className="rounded-md bg-primary/5 border border-primary/10 px-3 py-2">
          <div className="flex items-center justify-between mb-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              {toolResult.toolId}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-5 text-[10px]"
              onClick={() => setToolResult(null)}
            >
              Dismiss
            </Button>
          </div>
          <p className="text-xs text-foreground/80 whitespace-pre-wrap">{toolResult.text}</p>
        </div>
      )}
    </div>
  )
}

