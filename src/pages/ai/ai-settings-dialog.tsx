import { useState, useEffect, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useAIStore } from '@/stores/ai-store'
import { DEFAULT_SYSTEM_PROMPT } from '@/core/ai/soul'
import type { AIProvider } from '@/core/types/ai'

interface AISettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/* ─── Model Selector ─── */

function ModelSelector({
  provider,
  endpoint,
  model,
  onModelChange,
}: {
  provider: string
  endpoint: string
  model: string
  onModelChange: (model: string) => void
}) {
  const [models, setModels] = useState<string[]>([])
  const [loading, setLoading] = useState(false)

  const fetchModels = useCallback(async () => {
    if (provider !== 'ollama') {
      setModels([])
      return
    }
    setLoading(true)
    try {
      const baseUrl = (endpoint || 'http://localhost:11434/v1').replace(/\/v1$/, '')
      const res = await fetch(`${baseUrl}/api/tags`, { signal: AbortSignal.timeout(3000) })
      if (res.ok) {
        const data = await res.json()
        const names = (data.models as Array<{ name: string }>)?.map((m) => m.name) ?? []
        setModels(names)
      }
    } catch { /* silent */ }
    finally { setLoading(false) }
  }, [provider, endpoint])

  useEffect(() => { fetchModels() }, [fetchModels])

  // Ollama with models available — show dropdown
  if (provider === 'ollama' && models.length > 0) {
    return (
      <div className="space-y-2">
        <Label>Model</Label>
        <Select value={model} onValueChange={onModelChange}>
          <SelectTrigger>
            <SelectValue placeholder="Select model" />
          </SelectTrigger>
          <SelectContent>
            {models.map((m) => (
              <SelectItem key={m} value={m}>{m}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[10px] text-muted-foreground">
          {models.length} model{models.length !== 1 ? 's' : ''} installed
          {' · '}
          <button onClick={fetchModels} className="text-primary hover:underline">refresh</button>
        </p>
      </div>
    )
  }

  // Other providers or Ollama offline — text input
  return (
    <div className="space-y-2">
      <Label>Model</Label>
      <Input
        value={model}
        onChange={(e) => onModelChange(e.target.value)}
        placeholder={
          provider === 'ollama' ? 'qwen3:4b' :
          provider === 'grok' ? 'grok-3-mini' :
          provider === 'groq' ? 'llama-3.3-70b-versatile' :
          provider === 'gemini' ? 'gemini-2.0-flash' :
          'gpt-4o-mini'
        }
      />
      {provider === 'ollama' && !loading && models.length === 0 && (
        <p className="text-[10px] text-muted-foreground/50">
          Ollama offline — type model name manually or start Ollama
        </p>
      )}
    </div>
  )
}

export function AISettingsDialog({ open, onOpenChange }: AISettingsDialogProps) {
  const config = useAIStore((s) => s.config)
  const customSystemPrompt = useAIStore((s) => s.customSystemPrompt)
  const vision = useAIStore((s) => s.vision)
  const setConfig = useAIStore((s) => s.setConfig)
  const switchProvider = useAIStore((s) => s.switchProvider)
  const setCustomSystemPrompt = useAIStore((s) => s.setCustomSystemPrompt)
  const setVision = useAIStore((s) => s.setVision)

  const [provider, setProvider] = useState<AIProvider>(config.provider)
  const [endpoint, setEndpoint] = useState(config.endpoint)
  const [model, setModel] = useState(config.model)
  const [apiKey, setApiKey] = useState(config.apiKey)
  const [contextWindow, setContextWindow] = useState(config.contextWindow)
  const [promptDraft, setPromptDraft] = useState(customSystemPrompt)
  const [visionDraft, setVisionDraft] = useState(vision)

  useEffect(() => {
    setProvider(config.provider)
    setEndpoint(config.endpoint)
    setModel(config.model)
    setApiKey(config.apiKey)
    setContextWindow(config.contextWindow)
    setPromptDraft(customSystemPrompt)
    setVisionDraft(vision)
  }, [config, customSystemPrompt, vision, open])

  const handleProviderChange = (value: string) => {
    const p = value as AIProvider
    setProvider(p)
    switchProvider(p)
    const defaults = useAIStore.getState().config
    setEndpoint(defaults.endpoint)
    setModel(defaults.model)
    setApiKey(defaults.apiKey)
    setContextWindow(defaults.contextWindow)
  }

  const handleSave = () => {
    setConfig({ provider, endpoint, model, apiKey, contextWindow })
    setCustomSystemPrompt(promptDraft)
    setVision(visionDraft)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Lyra AI Settings</DialogTitle>
        </DialogHeader>
        <Tabs defaultValue="connection">
          <TabsList className="mb-4">
            <TabsTrigger value="connection">Connection</TabsTrigger>
            <TabsTrigger value="personality">Personality</TabsTrigger>
          </TabsList>

          <TabsContent value="connection" className="space-y-4">
            <div className="space-y-2">
              <Label>Provider</Label>
              <Select value={provider} onValueChange={handleProviderChange}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ollama">Ollama (local)</SelectItem>
                  <SelectItem value="grok">Grok (xAI)</SelectItem>
                  <SelectItem value="groq">Groq (free tier)</SelectItem>
                  <SelectItem value="gemini">Gemini (Google)</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="claude">Claude (proxy)</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Endpoint</Label>
              <Input
                value={endpoint}
                onChange={(e) => setEndpoint(e.target.value)}
                placeholder="https://api.openai.com/v1"
              />
            </div>

            <ModelSelector
              provider={provider}
              endpoint={endpoint}
              model={model}
              onModelChange={setModel}
            />

            <div className="space-y-2">
              <Label>API Key</Label>
              <Input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
              />
            </div>

            <div className="space-y-2">
              <Label>Context Window</Label>
              <Input
                type="number"
                value={contextWindow}
                onChange={(e) => setContextWindow(Number(e.target.value))}
              />
            </div>
          </TabsContent>

          <TabsContent value="personality" className="space-y-4">
            <div className="space-y-2">
              <Label>Your Vision</Label>
              <p className="text-[11px] text-muted-foreground">
                What are you building toward? Lyra considers this in every strategic recommendation.
              </p>
              <Textarea
                value={visionDraft}
                onChange={(e) => setVisionDraft(e.target.value)}
                placeholder="e.g. Build a profitable SaaS by 2027 while maintaining health and deep technical skills. Achieve financial independence through software and smart investing."
                rows={3}
                className="text-xs"
              />
            </div>

            <div className="space-y-2">
              <Label>System Prompt</Label>
              <p className="text-[11px] text-muted-foreground">
                Define who Lyra is. Leave empty to use the default personality.
              </p>
              <Textarea
                value={promptDraft}
                onChange={(e) => setPromptDraft(e.target.value)}
                placeholder={DEFAULT_SYSTEM_PROMPT}
                rows={12}
                className="text-xs font-mono leading-relaxed"
              />
            </div>

            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => setPromptDraft(DEFAULT_SYSTEM_PROMPT)}
              >
                Load Default
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-xs"
                onClick={() => setPromptDraft('')}
              >
                Reset to Default
              </Button>
            </div>

            <div className="rounded-md bg-muted/50 p-3 space-y-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">How it works</p>
              <ul className="text-[11px] text-muted-foreground space-y-0.5">
                <li>This prompt is injected into every AI interaction across Lyra.</li>
                <li>It defines Lyra's personality, tone, and behavior.</li>
                <li>Leave empty = default INTJ mastermind personality.</li>
                <li>Time-of-day awareness and word limits are always appended automatically.</li>
              </ul>
            </div>
          </TabsContent>
        </Tabs>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSave}>Save</Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
