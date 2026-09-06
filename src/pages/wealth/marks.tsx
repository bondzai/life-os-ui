/**
 * Chain and token marks — the small coloured tiles that let you scan a wealth table by shape and
 * colour instead of reading every row.
 *
 * Two rules hold the system together:
 *
 * - **Shape encodes kind.** A network is a rounded square, an asset is a circle. So "USDC on
 *   Base" reads as one circle and one square, and you never have to work out which of two words
 *   is the chain.
 * - **No remote logos.** Token art would mean a request per row to a third party, on a page that
 *   shows someone's net worth. Everything here is drawn locally: a glyph where the brand mark is
 *   simple enough to draw honestly, initials otherwise.
 */

import type { ReactNode } from 'react'
import { Bitcoin, Landmark } from 'lucide-react'
import { cn } from '@/lib/utils'
import { chainAccent, chainLabel, chainMono, readableInk, tokenAccent, tokenMono } from './identity'
import type { TokenAmt } from './types'

type MarkSize = 'sm' | 'md' | 'lg'

const BOX: Record<MarkSize, string> = {
  sm: 'size-5 text-[9px]',
  md: 'size-6 text-[10px]',
  lg: 'size-8 text-xs',
}

const GLYPH: Record<MarkSize, string> = {
  sm: 'size-3',
  md: 'size-3.5',
  lg: 'size-4.5',
}

/** The ETH rhombus. Two faces, the lower one dimmed, which is what makes it read as 3D. */
function EthGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M12 2 5.4 12.3 12 16.1l6.6-3.8L12 2Z" />
      <path d="M12 17.5 5.4 13.7 12 22.5l6.6-8.8L12 17.5Z" opacity=".65" />
    </svg>
  )
}

/** Solana's three slanted bars, alternating lean. */
function SolGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M6.6 5h14.1l-3.3 3.4H3.3L6.6 5Z" />
      <path d="M3.3 10.3h14.1l3.3 3.4H6.6l-3.3-3.4Z" />
      <path d="M6.6 15.6h14.1L17.4 19H3.3l3.3-3.4Z" />
    </svg>
  )
}

/** BNB's quincunx — four diamonds around a fifth. */
function BnbGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="m12 2.6 3.1 3.1L12 8.8 8.9 5.7 12 2.6Z" />
      <path d="m12 15.2 3.1 3.1L12 21.4l-3.1-3.1 3.1-3.1Z" />
      <path d="M5.7 8.9 8.8 12l-3.1 3.1L2.6 12l3.1-3.1Z" />
      <path d="M18.3 8.9 21.4 12l-3.1 3.1L15.2 12l3.1-3.1Z" />
      <path d="M12 8.9 15.1 12 12 15.1 8.9 12 12 8.9Z" />
    </svg>
  )
}

/**
 * Drawn marks, by chain slug. Anything absent falls back to initials — a wrong-looking logo is
 * worse than two honest letters.
 */
const CHAIN_GLYPHS: Record<string, (p: { className?: string }) => ReactNode> = {
  ethereum: EthGlyph,
  solana: SolGlyph,
  bnb: BnbGlyph,
  bitcoin: Bitcoin,
  'off-chain': Landmark,
}

/** Same drawn marks, reached by token symbol rather than chain slug. */
const TOKEN_GLYPHS: Record<string, (p: { className?: string }) => ReactNode> = {
  BTC: Bitcoin,
  WBTC: Bitcoin,
  CBBTC: Bitcoin,
  TBTC: Bitcoin,
  ETH: EthGlyph,
  WETH: EthGlyph,
  SOL: SolGlyph,
  BNB: BnbGlyph,
}

/** The network a balance sits on. Rounded square, brand colour, ink chosen for contrast. */
export function ChainMark({
  chain,
  size = 'sm',
  className,
}: {
  chain: string
  size?: MarkSize
  className?: string
}) {
  const slug = chain.toLowerCase()
  const accent = chainAccent(slug)
  const Glyph = CHAIN_GLYPHS[slug]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-[5px] font-semibold',
        BOX[size],
        className,
      )}
      style={{ backgroundColor: accent, color: readableInk(accent) }}
      // The label is always rendered as text next to the mark, so the tile itself is decoration.
      aria-hidden
    >
      {Glyph ? <Glyph className={GLYPH[size]} /> : chainMono(slug)}
    </span>
  )
}

/** Mark plus name. The pill replaces a bare `MetaPill` wherever the value is a network. */
export function ChainTag({
  chain,
  size = 'sm',
  className,
}: {
  chain: string
  size?: MarkSize
  className?: string
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md bg-muted py-0.5 pr-2 pl-0.5 text-xs whitespace-nowrap text-foreground/80',
        className,
      )}
    >
      <ChainMark chain={chain} size={size} />
      {chainLabel(chain)}
    </span>
  )
}

/** An asset. Circle, so it never reads as a network at a glance. */
export function TokenMark({
  symbol,
  size = 'sm',
  className,
}: {
  symbol: string
  size?: MarkSize
  className?: string
}) {
  const accent = tokenAccent(symbol)
  const Glyph = TOKEN_GLYPHS[symbol.toUpperCase()]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full font-semibold',
        BOX[size],
        className,
      )}
      style={{ backgroundColor: accent, color: readableInk(accent) }}
      aria-hidden
    >
      {Glyph ? <Glyph className={GLYPH[size]} /> : tokenMono(symbol)}
    </span>
  )
}

/**
 * The two sides of a pool, overlapped.
 *
 * Capped at two: an LP is a pair, and a reward-heavy farm can carry six token legs, which would
 * turn the first column into a smear. The ring is the theme's card colour so the discs separate
 * on both the table row and its hover state.
 *
 * The overlap is only 4px because these discs carry initials, not logos: a deeper overlap reads
 * fine with real token art but clipped "WHYPE" down to a lone W.
 */
export function TokenPairMark({
  tokens,
  size = 'sm',
  className,
}: {
  tokens: TokenAmt[]
  size?: MarkSize
  className?: string
}) {
  const shown = tokens.slice(0, 2)
  if (shown.length === 0) return null
  return (
    <span className={cn('inline-flex shrink-0 items-center', className)}>
      {shown.map((token, i) => (
        <TokenMark
          key={`${token.symbol}-${i}`}
          symbol={token.symbol}
          size={size}
          className={i > 0 ? '-ml-1 ring-2 ring-card' : undefined}
        />
      ))}
    </span>
  )
}
