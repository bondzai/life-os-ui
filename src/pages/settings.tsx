import { useState, useEffect } from 'react'
import { Database, Cloud, Sparkles, Info, Keyboard, AlertTriangle, RotateCcw } from 'lucide-react'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { APP_VERSION } from '@/lib/changelog-data'
import { generateMockData, clearMockData } from '@/lib/mock-data'
import { ACTIONS, useKeybindings, comboToDisplay, checkConflict } from '@/hooks/use-keybindings'

type DataMode = 'local' | 'api' | 'demo'

function getDataMode(): DataMode {
  const stored = localStorage.getItem('lyra:data-mode')
  if (stored === 'api' || stored === 'demo' || stored === 'local') return stored
  return import.meta.env.VITE_USE_API === 'true' ? 'api' : 'local'
}

function setDataMode(mode: DataMode) {
  if (mode === 'demo') {
    clearMockData()
    generateMockData()
  } else {
    const prev = getDataMode()
    if (prev === 'demo') clearMockData()
  }
  localStorage.setItem('lyra:data-mode', mode)
  window.location.reload()
}

const MODES: Array<{ mode: DataMode; icon: typeof Database; label: string; desc: string }> = [
  { mode: 'local', icon: Database, label: 'Local', desc: 'Browser storage' },
  { mode: 'api', icon: Cloud, label: 'API', desc: 'Server + database' },
  { mode: 'demo', icon: Sparkles, label: 'Demo', desc: 'Mock data' },
]

export function SettingsPage() {
  const currentMode = getDataMode()
  const { getCombo, setCombo, resetAll } = useKeybindings()
  const [recording, setRecording] = useState<string | null>(null)

  useEffect(() => {
    if (!recording) return
    const handler = (e: KeyboardEvent) => {
      if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return
      e.preventDefault()
      e.stopPropagation()
      setCombo(recording, {
        key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
        meta: e.metaKey || e.ctrlKey || undefined,
        shift: e.shiftKey || undefined,
        alt: e.altKey || undefined,
      })
      setRecording(null)
    }
    const cancel = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); setRecording(null) } }
    document.addEventListener('keydown', handler, true)
    document.addEventListener('keydown', cancel)
    return () => { document.removeEventListener('keydown', handler, true); document.removeEventListener('keydown', cancel) }
  }, [recording, setCombo])

  return (
    <div className="max-w-lg space-y-8">
      {/* Data Mode */}
      <section className="space-y-3">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">Data Mode</Label>
        <div className="grid grid-cols-3 gap-2">
          {MODES.map(({ mode, icon: Icon, label, desc }) => (
            <button
              key={mode}
              onClick={() => { if (currentMode !== mode) setDataMode(mode) }}
              className={`flex flex-col items-center gap-1.5 p-3 rounded-lg border text-center transition-colors cursor-pointer ${
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
      </section>

      <Separator />

      {/* Keyboard Shortcuts */}
      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground flex items-center gap-1.5">
            <Keyboard className="h-3 w-3" />
            Keyboard Shortcuts
          </Label>
          <Button variant="ghost" size="sm" className="h-6 text-[10px] text-muted-foreground gap-1" onClick={() => { resetAll(); setRecording(null) }}>
            <RotateCcw className="h-2.5 w-2.5" />
            Reset defaults
          </Button>
        </div>
        <div className="rounded-lg border divide-y">
          {ACTIONS.map((action) => {
            const combo = getCombo(action.id)
            const conflict = checkConflict(combo)
            const isRec = recording === action.id
            return (
              <div key={action.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{action.label}</p>
                  <p className="text-[11px] text-muted-foreground">{action.description}</p>
                </div>
                {conflict && !isRec && (
                  <span title={conflict}><AlertTriangle className="h-3.5 w-3.5 text-amber-500 shrink-0" /></span>
                )}
                <button
                  onClick={() => setRecording(action.id)}
                  className={`px-3 py-1 rounded-md text-xs font-mono cursor-pointer transition-colors ${
                    isRec ? 'bg-primary text-primary-foreground animate-pulse' : 'bg-muted hover:bg-muted/80'
                  }`}
                >
                  {isRec ? 'Press keys...' : comboToDisplay(combo)}
                </button>
              </div>
            )
          })}
        </div>
      </section>

      <Separator />

      {/* About */}
      <section className="space-y-3">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">About</Label>
        <div className="rounded-lg border p-4 space-y-2.5">
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
      </section>
    </div>
  )
}
