import { useState, useEffect, useCallback, useRef } from 'react'
import { Play, Pause, RotateCcw, Timer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

type TimerMode = 'idle' | 'work' | 'break'

const WORK_SECONDS = 25 * 60
const BREAK_SECONDS = 5 * 60

function playBeep() {
  try {
    const ctx = new AudioContext()
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.connect(gain)
    gain.connect(ctx.destination)
    osc.frequency.value = 880
    gain.gain.value = 0.3
    osc.start()
    osc.stop(ctx.currentTime + 0.2)
    setTimeout(() => ctx.close(), 500)
  } catch {
    // Web Audio not available
  }
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

export function PomodoroTimer() {
  const [mode, setMode] = useState<TimerMode>('idle')
  const [secondsLeft, setSecondsLeft] = useState(WORK_SECONDS)
  const [isRunning, setIsRunning] = useState(false)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clearTimer = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current)
      intervalRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!isRunning) {
      clearTimer()
      return
    }

    intervalRef.current = setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          playBeep()
          setIsRunning(false)
          if (mode === 'work') {
            setMode('break')
            return BREAK_SECONDS
          } else {
            setMode('idle')
            return WORK_SECONDS
          }
        }
        return prev - 1
      })
    }, 1000)

    return clearTimer
  }, [isRunning, mode, clearTimer])

  const handleStart = () => {
    if (mode === 'idle') setMode('work')
    setIsRunning(true)
  }

  const handleReset = () => {
    clearTimer()
    setMode('idle')
    setSecondsLeft(WORK_SECONDS)
    setIsRunning(false)
  }

  const modeLabel = mode === 'work' ? 'Focus' : mode === 'break' ? 'Break' : 'Ready'
  const modeColor = mode === 'work' ? 'text-red-500' : mode === 'break' ? 'text-green-500' : 'text-muted-foreground'

  return (
    <Card>
      <CardContent className="p-3 flex items-center gap-3">
        <Timer className={`h-5 w-5 shrink-0 ${modeColor}`} />
        <div className="flex items-center gap-2 flex-1">
          <span className={`text-xs font-medium uppercase ${modeColor}`}>{modeLabel}</span>
          <span className="text-lg font-mono font-bold tabular-nums">{formatTime(secondsLeft)}</span>
        </div>
        <div className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={isRunning ? () => setIsRunning(false) : handleStart}
          >
            {isRunning ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-7 w-7 p-0"
            onClick={handleReset}
            disabled={mode === 'idle' && !isRunning}
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
