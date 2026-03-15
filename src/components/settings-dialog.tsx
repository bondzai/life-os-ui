import { Database, Cloud, Sparkles, Info } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { APP_VERSION } from '@/lib/changelog-data'
import { generateMockData, clearMockData } from '@/lib/mock-data'

type DataMode = 'local' | 'api' | 'demo'

function getDataMode(): DataMode {
  const stored = localStorage.getItem('life-os:data-mode')
  if (stored === 'api' || stored === 'demo' || stored === 'local') return stored
  return import.meta.env.VITE_USE_API === 'true' ? 'api' : 'local'
}

function setDataMode(mode: DataMode) {
  if (mode === 'demo') {
    clearMockData()
    generateMockData()
  } else {
    const prev = getDataMode()
    if (prev === 'demo') {
      clearMockData()
    }
  }
  localStorage.setItem('life-os:data-mode', mode)
  window.location.reload()
}

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

const MODES: Array<{ mode: DataMode; icon: typeof Database; label: string; desc: string }> = [
  { mode: 'local', icon: Database, label: 'Local', desc: 'Browser storage' },
  { mode: 'api', icon: Cloud, label: 'API', desc: 'Server + database' },
  { mode: 'demo', icon: Sparkles, label: 'Demo', desc: 'Mock data' },
]

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const currentMode = getDataMode()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>Configure your Life-OS experience.</DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Data Mode Toggle */}
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">Data Mode</Label>
            <div className="grid grid-cols-3 gap-2">
              {MODES.map(({ mode, icon: Icon, label, desc }) => (
                <button
                  key={mode}
                  onClick={() => { if (currentMode !== mode) setDataMode(mode) }}
                  className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border text-center transition-colors ${
                    currentMode === mode
                      ? 'border-primary bg-primary/5'
                      : 'border-border hover:bg-muted/50'
                  }`}
                >
                  <Icon className={`h-5 w-5 ${currentMode === mode ? 'text-primary' : 'text-muted-foreground'}`} />
                  <div>
                    <p className="text-sm font-medium">{label}</p>
                    <p className="text-[10px] text-muted-foreground">{desc}</p>
                  </div>
                </button>
              ))}
            </div>
            <p className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
              <Info className="h-3 w-3 shrink-0" />
              {currentMode === 'demo'
                ? 'Demo mode fills the app with sample data. Switch to Local to start fresh.'
                : 'Switching modes will reload the page.'
              }
            </p>
          </div>

          {/* App Info */}
          <div className="space-y-2">
            <Label className="text-xs uppercase tracking-wider text-muted-foreground">About</Label>
            <div className="rounded-lg border p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm">Version</span>
                <Badge variant="secondary" className="text-xs">v{APP_VERSION}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">Data mode</span>
                <Badge variant="outline" className="text-xs capitalize">{currentMode}</Badge>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm">Platform</span>
                <span className="text-xs text-muted-foreground">React + TypeScript + Vite</span>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
