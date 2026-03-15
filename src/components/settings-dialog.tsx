import { Database, Cloud, Info } from 'lucide-react'
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

type DataMode = 'local' | 'api'

function getDataMode(): DataMode {
  const stored = localStorage.getItem('life-os:data-mode')
  if (stored === 'api') return 'api'
  if (stored === 'local') return 'local'
  return import.meta.env.VITE_USE_API === 'true' ? 'api' : 'local'
}

function setDataMode(mode: DataMode) {
  localStorage.setItem('life-os:data-mode', mode)
  window.location.reload()
}

interface SettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

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
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => { if (currentMode !== 'local') setDataMode('local') }}
                className={`flex flex-col items-center gap-2 p-3 rounded-lg border text-center transition-colors ${
                  currentMode === 'local'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
                }`}
              >
                <Database className={`h-5 w-5 ${currentMode === 'local' ? 'text-primary' : 'text-muted-foreground'}`} />
                <div>
                  <p className="text-sm font-medium">Local</p>
                  <p className="text-[10px] text-muted-foreground">Browser storage</p>
                </div>
              </button>
              <button
                onClick={() => { if (currentMode !== 'api') setDataMode('api') }}
                className={`flex flex-col items-center gap-2 p-3 rounded-lg border text-center transition-colors ${
                  currentMode === 'api'
                    ? 'border-primary bg-primary/5'
                    : 'border-border hover:bg-muted/50'
                }`}
              >
                <Cloud className={`h-5 w-5 ${currentMode === 'api' ? 'text-primary' : 'text-muted-foreground'}`} />
                <div>
                  <p className="text-sm font-medium">API</p>
                  <p className="text-[10px] text-muted-foreground">Server + database</p>
                </div>
              </button>
            </div>
            <p className="text-[10px] text-muted-foreground/60 flex items-center gap-1">
              <Info className="h-3 w-3 shrink-0" />
              Switching modes will reload the page.
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
