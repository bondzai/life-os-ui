import { useState } from 'react'
import { Sun, Moon, Check, ChevronRight } from 'lucide-react'
import { useNavigate } from 'react-router'
import { getProtocolState, setProtocolDone } from './today-helpers'

interface Step {
  label: string
  action?: () => void
}

interface ProtocolProps {
  onComplete: () => void
}

function ProtocolFlow({ steps, onComplete }: { steps: Step[]; onComplete: () => void }) {
  const [current, setCurrent] = useState(0)

  const advance = () => {
    const step = steps[current]
    step.action?.()
    if (current < steps.length - 1) {
      setCurrent(current + 1)
    } else {
      onComplete()
    }
  }

  return (
    <div className="space-y-2">
      {steps.map((step, i) => (
        <button
          key={i}
          onClick={() => i === current && advance()}
          disabled={i !== current}
          className={`flex items-center gap-3 w-full py-2 px-3 rounded-lg text-left text-sm transition-all ${
            i < current
              ? 'text-muted-foreground/50 line-through'
              : i === current
                ? 'bg-muted/50 font-medium'
                : 'text-muted-foreground/40'
          }`}
        >
          {i < current ? (
            <Check className="h-4 w-4 text-green-500 shrink-0" />
          ) : i === current ? (
            <ChevronRight className="h-4 w-4 text-primary shrink-0" />
          ) : (
            <span className="w-4 h-4 shrink-0" />
          )}
          {step.label}
        </button>
      ))}
    </div>
  )
}

export function MorningProtocol({ onComplete }: ProtocolProps) {
  const navigate = useNavigate()

  const steps: Step[] = [
    { label: 'Review today\'s 3 priorities' },
    { label: 'Review strategic goals', action: () => navigate('/goals') },
    { label: 'Check inbox for overnight items' },
    { label: 'Ready to execute', action: () => { setProtocolDone('morning'); onComplete() } },
  ]

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Sun className="h-4 w-4 text-amber-500" />
        <span className="text-sm font-medium">Morning Protocol</span>
      </div>
      <ProtocolFlow steps={steps} onComplete={() => { setProtocolDone('morning'); onComplete() }} />
    </div>
  )
}

export function EveningProtocol({ onComplete }: ProtocolProps) {
  const navigate = useNavigate()

  const steps: Step[] = [
    { label: 'Journal today\'s insights' },
    { label: 'Archive completed tasks', action: () => navigate('/tasks') },
    { label: 'Set tomorrow\'s 3 priorities' },
    { label: 'Day complete', action: () => { setProtocolDone('evening'); onComplete() } },
  ]

  return (
    <div>
      <div className="flex items-center gap-2 mb-3">
        <Moon className="h-4 w-4 text-indigo-400" />
        <span className="text-sm font-medium">Evening Protocol</span>
      </div>
      <ProtocolFlow steps={steps} onComplete={() => { setProtocolDone('evening'); onComplete() }} />
    </div>
  )
}

export function DailyProtocol() {
  const [activeProtocol, setActiveProtocol] = useState<'morning' | 'evening' | null>(null)
  const [protocolState, setProtocolState] = useState(() => getProtocolState())

  const isMorning = new Date().getHours() < 14

  if (activeProtocol === 'morning') {
    return (
      <MorningProtocol
        onComplete={() => {
          setActiveProtocol(null)
          setProtocolState(getProtocolState())
        }}
      />
    )
  }

  if (activeProtocol === 'evening') {
    return (
      <EveningProtocol
        onComplete={() => {
          setActiveProtocol(null)
          setProtocolState(getProtocolState())
        }}
      />
    )
  }

  return (
    <div className="space-y-1">
      <button
        onClick={() => setActiveProtocol('morning')}
        disabled={protocolState.morning}
        className={`flex items-center gap-3 w-full py-2.5 px-3 rounded-lg text-left transition-colors ${
          protocolState.morning
            ? 'text-muted-foreground/40'
            : isMorning
              ? 'bg-amber-500/5 hover:bg-amber-500/10 text-foreground'
              : 'hover:bg-muted/50 text-muted-foreground'
        }`}
      >
        <Sun className={`h-4 w-4 shrink-0 ${protocolState.morning ? 'text-green-500' : 'text-amber-500'}`} />
        <span className={`text-sm flex-1 ${protocolState.morning ? 'line-through' : 'font-medium'}`}>
          Morning Review
        </span>
        {protocolState.morning ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
        )}
      </button>

      <button
        onClick={() => setActiveProtocol('evening')}
        disabled={protocolState.evening}
        className={`flex items-center gap-3 w-full py-2.5 px-3 rounded-lg text-left transition-colors ${
          protocolState.evening
            ? 'text-muted-foreground/40'
            : !isMorning
              ? 'bg-indigo-500/5 hover:bg-indigo-500/10 text-foreground'
              : 'hover:bg-muted/50 text-muted-foreground'
        }`}
      >
        <Moon className={`h-4 w-4 shrink-0 ${protocolState.evening ? 'text-green-500' : 'text-indigo-400'}`} />
        <span className={`text-sm flex-1 ${protocolState.evening ? 'line-through' : 'font-medium'}`}>
          Evening Review
        </span>
        {protocolState.evening ? (
          <Check className="h-3.5 w-3.5 text-green-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground/50" />
        )}
      </button>
    </div>
  )
}
