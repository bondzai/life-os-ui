/**
 * Small presentational pieces shared by the wealth surfaces.
 *
 * Kept together so a number means the same thing everywhere: green/red always encodes direction
 * of change, never good/bad, and a missing value always renders as an em dash rather than 0 —
 * "we don't know" and "it's zero" are different facts about someone's money.
 */

import type { ReactNode } from 'react'
import { Droplets, Sprout, TrendingUp, TrendingDown } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { formatPct } from './format'
import { useMoney } from './money'

/** A headline metric. `hint` carries the qualifier (timeframe, basis) that keeps it honest. */
export function StatCard({
  label,
  value,
  hint,
  accent,
  children,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  accent?: boolean
  children?: ReactNode
}) {
  // `py-0` cancels the Card's own `py-6`, which stacked with the content's padding and made a
  // three-line tile 157px tall. These sit in a row above every wealth surface; a whole screen of
  // headline before the first row of data is what pushed the real content below the fold.
  return (
    <Card className="gap-0 py-0">
      <CardContent className="px-4 py-3">
        <p className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
        <p className={cn('mt-0.5 font-semibold tabular-nums', accent ? 'text-xl' : 'text-lg')}>{value}</p>
        {hint && <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">{hint}</p>}
        {children}
      </CardContent>
    </Card>
  )
}

/** Signed percentage with direction colour. Renders nothing legible-but-wrong when data is absent. */
export function ChangeBadge({ value, className }: { value: number | null; className?: string }) {
  if (value === null || !Number.isFinite(value)) {
    return <span className={cn('text-sm text-muted-foreground', className)}>—</span>
  }
  const up = value >= 0
  const Icon = up ? TrendingUp : TrendingDown
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 text-sm font-medium tabular-nums',
        up ? 'text-emerald-700 dark:text-emerald-500' : 'text-red-700 dark:text-red-400',
        className,
      )}
    >
      <Icon className="size-3.5" />
      {formatPct(value)}
    </span>
  )
}

/** Plain signed number without the icon, for dense table cells. */
export function ChangeText({ value }: { value: number | null }) {
  if (value === null || !Number.isFinite(value)) return <span className="text-muted-foreground">—</span>
  return (
    <span className={cn('tabular-nums', value >= 0 ? 'text-emerald-700 dark:text-emerald-500' : 'text-red-700 dark:text-red-400')}>
      {formatPct(value)}
    </span>
  )
}

/**
 * A signed amount of money — a profit, a loss, or "not reported".
 *
 * The sign is written out rather than left to the minus the locale would supply, so a gain and a
 * loss are the same width and a column of them stays scannable. Colour repeats what the sign
 * already says; it is never the only carrier.
 */
export function Pnl({ usd }: { usd: number | null }) {
  const { money } = useMoney()
  if (usd === null || !Number.isFinite(usd)) return <span className="text-muted-foreground">—</span>
  const up = usd >= 0
  return (
    <span className={cn('tabular-nums', up ? 'text-emerald-700 dark:text-emerald-500' : 'text-red-700 dark:text-red-400')}>
      {up ? '+' : '−'}
      {money(Math.abs(usd))}
    </span>
  )
}

/**
 * Out-of-range / unknown / full-range — and **nothing at all when the position is fine**.
 *
 * A badge on the healthy majority is noise. It was the loudest thing in the row — solid green,
 * white text — repeating what the green marker in the Range column already said, on every row that
 * needed no attention, which made the one row that did need attention harder to find. Badging the
 * exception is the whole job.
 *
 * The other three states stay. `null` is not "fine": a position whose range the server could not
 * determine must never render as healthy, so it keeps its neutral badge. `full` is not a health
 * state at all — it says this is a different kind of position, which is worth a word.
 */
export function RangeBadge({ inRange, full }: { inRange: boolean | null; full?: boolean }) {
  if (full) return <Badge variant="secondary">Full range</Badge>
  if (inRange === null) return <Badge variant="outline">Unknown</Badge>
  if (inRange) return null
  return <Badge variant="destructive">Out of range</Badge>
}

/**
 * Where spot sits inside an LP's price band.
 *
 * The marker is clamped to the track, so an out-of-range position pins to the edge it broke
 * through instead of drawing outside the box and looking like a rendering bug.
 */
export function RangeBar({
  posPct,
  out,
  className,
}: {
  posPct: number
  out: boolean
  /** Width override. The table wants a fixed, narrow bar; the card wants the full width. */
  className?: string
}) {
  return (
    <div
      className={cn('relative h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
      role="presentation"
    >
      <div
        className={cn('absolute top-0 h-full w-1 rounded-full', out ? 'bg-red-500' : 'bg-emerald-500')}
        style={{ left: `calc(${Math.min(100, Math.max(0, posPct))}% - 2px)` }}
      />
    </div>
  )
}

/**
 * Whether a position is a plain pool or staked into a farm, as a glyph.
 *
 * It was the literal word `pool` or `farm` in a grey pill, which is a lot of row for a binary that
 * repeats on every line. vfat draws it: a droplet for liquidity sitting in a pool, a sprout for
 * liquidity staked and growing. The distinction is worth keeping — a farm earns emissions a pool
 * does not — it just does not need six characters and a border to say so.
 *
 * The label is on the element, not implied by the picture: an icon alone is unreadable to a screen
 * reader and ambiguous to anyone who has not learned the convention, so `aria-label` carries the
 * word and `title` shows it on hover. An unrecognised value keeps its text rather than being
 * guessed at or dropped.
 */
export function PoolTypeMark({ type }: { type: string }) {
  const known =
    type === 'pool'
      ? { Icon: Droplets, label: 'Pool — earns swap fees' }
      : type === 'farm'
        ? { Icon: Sprout, label: 'Farm — staked, also earns rewards' }
        : null

  if (!known) return <MetaPill>{type}</MetaPill>

  const { Icon, label } = known
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="inline-flex shrink-0 text-muted-foreground"
    >
      <Icon className="size-3.5" aria-hidden="true" />
    </span>
  )
}

/** Chain / account pill used in dense rows. */
export function MetaPill({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{children}</span>
  )
}
