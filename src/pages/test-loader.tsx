import { useState } from 'react'
import { LyraLoader, LyraPageLoader } from '@/components/lyra-loader'
import { Button } from '@/components/ui/button'

function DelayedContent({ delay, children }: { delay: number; children: React.ReactNode }) {
  const [ready, setReady] = useState(false)

  if (!ready) {
    return (
      <div className="flex flex-col items-center gap-4">
        <LyraPageLoader label={`Loading (${(delay / 1000).toFixed(1)}s)…`} />
        <HiddenTrigger delay={delay} onReady={() => setReady(true)} />
      </div>
    )
  }

  return <>{children}</>
}

function HiddenTrigger({ delay, onReady }: { delay: number; onReady: () => void }) {
  useState(() => {
    const t = setTimeout(onReady, delay)
    return () => clearTimeout(t)
  })
  return null
}

export function TestLoaderPage() {
  const [scenario, setScenario] = useState<'idle' | 'page' | 'inline' | 'sizes'>('idle')

  return (
    <div className="max-w-2xl mx-auto space-y-8">
      <div>
        <h1 className="text-2xl font-bold">Lyra Loader Test</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Click a scenario to see the loader hold before content renders.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button variant={scenario === 'page' ? 'default' : 'outline'} onClick={() => setScenario('page')}>
          Page Load (3s)
        </Button>
        <Button variant={scenario === 'inline' ? 'default' : 'outline'} onClick={() => setScenario('inline')}>
          Inline Load (2s)
        </Button>
        <Button variant={scenario === 'sizes' ? 'default' : 'outline'} onClick={() => setScenario('sizes')}>
          Size Variants
        </Button>
        {scenario !== 'idle' && (
          <Button variant="ghost" onClick={() => setScenario('idle')}>
            Reset
          </Button>
        )}
      </div>

      {scenario === 'page' && (
        <DelayedContent delay={3000}>
          <div className="rounded-lg border p-6 text-center space-y-2">
            <p className="text-lg font-medium">Content loaded</p>
            <p className="text-sm text-muted-foreground">The page loader held for 3 seconds before this appeared.</p>
          </div>
        </DelayedContent>
      )}

      {scenario === 'inline' && (
        <div className="grid grid-cols-2 gap-4">
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground mb-3 font-medium">Card A</p>
            <DelayedContent delay={2000}>
              <p className="text-sm">Loaded after 2s</p>
            </DelayedContent>
          </div>
          <div className="rounded-lg border p-4">
            <p className="text-xs text-muted-foreground mb-3 font-medium">Card B</p>
            <DelayedContent delay={3500}>
              <p className="text-sm">Loaded after 3.5s</p>
            </DelayedContent>
          </div>
        </div>
      )}

      {scenario === 'sizes' && (
        <div className="flex items-end gap-8 justify-center py-8">
          <div className="flex flex-col items-center gap-2">
            <LyraLoader size={14} />
            <span className="text-[10px] text-muted-foreground">14px</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <LyraLoader size={24} />
            <span className="text-[10px] text-muted-foreground">24px</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <LyraLoader size={48} label="Default" />
            <span className="text-[10px] text-muted-foreground">48px</span>
          </div>
          <div className="flex flex-col items-center gap-2">
            <LyraLoader size={80} label="Large" />
            <span className="text-[10px] text-muted-foreground">80px</span>
          </div>
        </div>
      )}
    </div>
  )
}
