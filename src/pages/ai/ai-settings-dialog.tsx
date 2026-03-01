import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useAIStore } from '@/stores/ai-store'
import type { AIProvider } from '@/core/types/ai'

interface AISettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function AISettingsDialog({ open, onOpenChange }: AISettingsDialogProps) {
  const config = useAIStore((s) => s.config)
  const setConfig = useAIStore((s) => s.setConfig)
  const switchProvider = useAIStore((s) => s.switchProvider)

  const [provider, setProvider] = useState<AIProvider>(config.provider)
  const [endpoint, setEndpoint] = useState(config.endpoint)
  const [model, setModel] = useState(config.model)
  const [apiKey, setApiKey] = useState(config.apiKey)
  const [contextWindow, setContextWindow] = useState(config.contextWindow)

  useEffect(() => {
    setProvider(config.provider)
    setEndpoint(config.endpoint)
    setModel(config.model)
    setApiKey(config.apiKey)
    setContextWindow(config.contextWindow)
  }, [config, open])

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
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>AI Settings</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Provider</Label>
            <Select value={provider} onValueChange={handleProviderChange}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai">OpenAI</SelectItem>
                <SelectItem value="claude">Claude (proxy)</SelectItem>
                <SelectItem value="ollama">Ollama</SelectItem>
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

          <div className="space-y-2">
            <Label>Model</Label>
            <Input
              value={model}
              onChange={(e) => setModel(e.target.value)}
              placeholder="gpt-4o-mini"
            />
          </div>

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

          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button onClick={handleSave}>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
