import { useState, useEffect, useCallback } from 'react'
import { Keyboard, AlertTriangle, RotateCcw } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  ACTIONS,
  useKeybindings,
  comboToDisplay,
  checkConflict,
  type KeyCombo,
} from '@/hooks/use-keybindings'

interface KeybindingDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function KeybindingDialog({ open, onOpenChange }: KeybindingDialogProps) {
  const { getCombo, setCombo, resetAll } = useKeybindings()
  const [recording, setRecording] = useState<string | null>(null)

  const handleRecord = useCallback((actionId: string) => {
    setRecording(actionId)
  }, [])

  // Listen for key combo when recording
  useEffect(() => {
    if (!recording) return
    const handler = (e: KeyboardEvent) => {
      // Ignore modifier-only presses
      if (['Meta', 'Control', 'Shift', 'Alt'].includes(e.key)) return
      e.preventDefault()
      e.stopPropagation()

      const combo: KeyCombo = {
        key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
        meta: e.metaKey || e.ctrlKey || undefined,
        shift: e.shiftKey || undefined,
        alt: e.altKey || undefined,
      }

      setCombo(recording, combo)
      setRecording(null)
    }
    const cancel = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setRecording(null)
      }
    }
    document.addEventListener('keydown', handler, true)
    document.addEventListener('keydown', cancel)
    return () => {
      document.removeEventListener('keydown', handler, true)
      document.removeEventListener('keydown', cancel)
    }
  }, [recording, setCombo])

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); setRecording(null) }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Keyboard className="h-4 w-4" />
            Keyboard Shortcuts
          </DialogTitle>
          <DialogDescription>
            Click a shortcut to rebind. Press Escape to cancel.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          {ACTIONS.map((action) => {
            const combo = getCombo(action.id)
            const conflict = checkConflict(combo)
            const isRecording = recording === action.id

            return (
              <div
                key={action.id}
                className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-muted/50 transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{action.label}</p>
                  <p className="text-[11px] text-muted-foreground">{action.description}</p>
                </div>

                <button
                  onClick={() => handleRecord(action.id)}
                  className={`px-2.5 py-1 rounded-md text-xs font-mono transition-colors cursor-pointer ${
                    isRecording
                      ? 'bg-primary text-primary-foreground animate-pulse'
                      : 'bg-muted hover:bg-muted/80'
                  }`}
                >
                  {isRecording ? 'Press keys...' : comboToDisplay(combo)}
                </button>

                {conflict && !isRecording && (
                  <Badge variant="outline" className="text-[9px] border-amber-500/30 text-amber-500 gap-1 shrink-0">
                    <AlertTriangle className="h-2.5 w-2.5" />
                    {conflict}
                  </Badge>
                )}
              </div>
            )
          })}
        </div>

        <div className="flex justify-end pt-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1.5 text-xs text-muted-foreground"
            onClick={() => { resetAll(); setRecording(null) }}
          >
            <RotateCcw className="h-3 w-3" />
            Reset to defaults
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
