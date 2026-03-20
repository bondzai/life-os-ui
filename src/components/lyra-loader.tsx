import { useEffect, useState } from 'react'

/**
 * Lyra constellation loader — stars connect one by one,
 * each line and node lighting up progressively.
 */

// Constellation geometry (same as sidebar logo)
const STARS = [
  { x: 12, y: 3, r: 2.2 },     // 0 — Vega (top, brightest)
  { x: 8.5, y: 7.5, r: 1.4 },  // 1
  { x: 15.5, y: 7.5, r: 1.4 }, // 2
  { x: 8, y: 14, r: 1.2 },     // 3
  { x: 16, y: 14, r: 1.2 },    // 4
  { x: 9.5, y: 19.5, r: 1 },   // 5
  { x: 14.5, y: 19.5, r: 1 },  // 6
]

// Edges drawn in sequence (index pairs into STARS)
const EDGES: [number, number][] = [
  [0, 1], // Vega → left shoulder
  [0, 2], // Vega → right shoulder
  [1, 3], // left shoulder → left hip
  [2, 4], // right shoulder → right hip
  [3, 5], // left hip → left foot
  [4, 6], // right hip → right foot
  [5, 6], // bottom bar
]

const TOTAL_STEPS = EDGES.length
const STEP_MS = 320
const HOLD_MS = 600
const CYCLE_MS = TOTAL_STEPS * STEP_MS + HOLD_MS

interface LyraLoaderProps {
  size?: number
  label?: string
  className?: string
}

export function LyraLoader({ size = 48, label, className = '' }: LyraLoaderProps) {
  const [step, setStep] = useState(0)

  useEffect(() => {
    let frame = 0
    const interval = setInterval(() => {
      frame++
      const pos = (frame * STEP_MS) % CYCLE_MS
      if (pos >= TOTAL_STEPS * STEP_MS) {
        setStep(TOTAL_STEPS) // all lit
      } else {
        setStep(Math.floor(pos / STEP_MS))
      }
    }, STEP_MS)
    return () => clearInterval(interval)
  }, [])

  // Which stars are "lit" — a star lights when any of its edges has been drawn
  const litStars = new Set<number>()
  for (let i = 0; i <= step && i < EDGES.length; i++) {
    litStars.add(EDGES[i][0])
    litStars.add(EDGES[i][1])
  }

  const scale = size / 24

  return (
    <div className={`flex flex-col items-center gap-3 ${className}`}>
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        className="drop-shadow-lg"
      >
        {/* Glow filter */}
        <defs>
          <filter id="lyra-glow" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={1.2 / scale} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <filter id="lyra-glow-strong" x="-50%" y="-50%" width="200%" height="200%">
            <feGaussianBlur stdDeviation={2 / scale} result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>

        {/* Edges — dim base lines always visible */}
        {EDGES.map(([a, b], i) => (
          <line
            key={`base-${i}`}
            x1={STARS[a].x}
            y1={STARS[a].y}
            x2={STARS[b].x}
            y2={STARS[b].y}
            stroke="#94a3b8"
            strokeWidth={0.5}
            opacity={0.15}
          />
        ))}

        {/* Edges — lit lines */}
        {EDGES.map(([a, b], i) => {
          const lit = i <= step
          return (
            <line
              key={`lit-${i}`}
              x1={STARS[a].x}
              y1={STARS[a].y}
              x2={STARS[b].x}
              y2={STARS[b].y}
              stroke="#60a5fa"
              strokeWidth={lit ? 1 : 0}
              opacity={lit ? 0.8 : 0}
              filter={lit ? 'url(#lyra-glow)' : undefined}
              className="transition-all duration-300 ease-out"
            />
          )
        })}

        {/* Stars — dim base */}
        {STARS.map((star, i) => (
          <circle
            key={`dim-${i}`}
            cx={star.x}
            cy={star.y}
            r={star.r * 0.6}
            fill="#475569"
            opacity={0.3}
          />
        ))}

        {/* Stars — lit */}
        {STARS.map((star, i) => {
          const lit = litStars.has(i)
          const isVega = i === 0
          return (
            <circle
              key={`star-${i}`}
              cx={star.x}
              cy={star.y}
              r={lit ? star.r : star.r * 0.4}
              fill={lit ? (isVega ? '#93c5fd' : '#60a5fa') : 'transparent'}
              opacity={lit ? 1 : 0}
              filter={lit ? (isVega ? 'url(#lyra-glow-strong)' : 'url(#lyra-glow)') : undefined}
              className="transition-all duration-300 ease-out"
            />
          )
        })}
      </svg>

      {label && (
        <span className="text-xs text-muted-foreground/60 animate-pulse">{label}</span>
      )}
    </div>
  )
}

/**
 * Full-page loader with centered Lyra constellation.
 */
export function LyraPageLoader({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center py-20">
      <LyraLoader size={48} label={label} />
    </div>
  )
}
