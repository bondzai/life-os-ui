/**
 * What a chain or a token is *called*, and what colour it wears.
 *
 * The API keys chains by lowercase slug (`bnb`, `hyperevm`, `kucoin`). Title-casing those
 * produced "Bnb", "Hyperevm" and "Kucoin" — names no one uses, which read as a data bug rather
 * than a network. Display names live here so every surface says the same thing.
 *
 * Colour is decoration that reinforces, never information on its own: every mark that uses an
 * accent is rendered beside the symbol or chain name in text, so a reader who cannot separate
 * the hues loses nothing.
 */

export interface ChainMeta {
  /** What a person calls the network. */
  label: string
  /** Brand hex. Ink is derived from it, so a light brand (mint, yellow) is safe to use as-is. */
  accent: string
  /** Two-letter fallback for chains with no drawn glyph. */
  mono: string
}

/**
 * Keyed by the slug the Rust fan-out emits (`lyra-chain/src/chains.rs`), plus the two
 * pseudo-chains the UI adds: `kucoin` for exchange balances and `off-chain` for manual assets.
 */
const CHAINS: Record<string, ChainMeta> = {
  ethereum: { label: 'Ethereum', accent: '#627EEA', mono: 'ET' },
  base: { label: 'Base', accent: '#0052FF', mono: 'BA' },
  arbitrum: { label: 'Arbitrum', accent: '#12AAFF', mono: 'AR' },
  optimism: { label: 'Optimism', accent: '#FF0420', mono: 'OP' },
  polygon: { label: 'Polygon', accent: '#8247E5', mono: 'PO' },
  bnb: { label: 'BNB Chain', accent: '#F0B90B', mono: 'BN' },
  avalanche: { label: 'Avalanche', accent: '#E84142', mono: 'AV' },
  hyperevm: { label: 'HyperEVM', accent: '#50D2C1', mono: 'HE' },
  hyperliquid: { label: 'Hyperliquid', accent: '#97FCE4', mono: 'HL' },
  bitcoin: { label: 'Bitcoin', accent: '#F7931A', mono: 'BT' },
  solana: { label: 'Solana', accent: '#9945FF', mono: 'SO' },
  kucoin: { label: 'KuCoin', accent: '#24AE8F', mono: 'KC' },
  'off-chain': { label: 'Off-chain', accent: '#71717A', mono: 'OC' },
}

/** Every colour here clears 4.5:1 against white, so a hashed fallback is never unreadable. */
const FALLBACK_ACCENTS = [
  '#4F46E5',
  '#0F766E',
  '#B45309',
  '#BE123C',
  '#6D28D9',
  '#0369A1',
  '#15803D',
  '#9D174D',
]

/** Stable across reloads, so an unknown token keeps the same colour session to session. */
function hashIndex(key: string, buckets: number): number {
  let h = 0
  for (let i = 0; i < key.length; i += 1) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return h % buckets
}

/** `bnb` → `BNB Chain`. An unrecognised slug is title-cased word by word rather than dropped. */
export function chainLabel(chain: string): string {
  if (!chain) return '—'
  const known = CHAINS[chain.toLowerCase()]
  if (known) return known.label
  return chain
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export function chainAccent(chain: string): string {
  return CHAINS[chain.toLowerCase()]?.accent ?? FALLBACK_ACCENTS[hashIndex(chain, FALLBACK_ACCENTS.length)]
}

export function chainMono(chain: string): string {
  const known = CHAINS[chain.toLowerCase()]
  if (known) return known.mono
  return chain.slice(0, 2).toUpperCase() || '?'
}

/** Wrapped and staked variants inherit the colour of what they represent — a WBTC row is BTC. */
const TOKEN_ACCENTS: Record<string, string> = {
  BTC: '#F7931A',
  WBTC: '#F7931A',
  CBBTC: '#F7931A',
  TBTC: '#F7931A',
  ETH: '#627EEA',
  WETH: '#627EEA',
  STETH: '#627EEA',
  WSTETH: '#627EEA',
  CBETH: '#627EEA',
  USDC: '#2775CA',
  USDBC: '#2775CA',
  USDT: '#26A17B',
  DAI: '#F5AC37',
  FRAX: '#3B3B3B',
  SOL: '#9945FF',
  BNB: '#F0B90B',
  AVAX: '#E84142',
  POL: '#8247E5',
  MATIC: '#8247E5',
  ARB: '#12AAFF',
  OP: '#FF0420',
  HYPE: '#50D2C1',
  AAVE: '#B6509E',
  AERO: '#0433FF',
  VELO: '#FF1E1E',
  LINK: '#2A5ADA',
  UNI: '#FF007A',
  CRV: '#40649F',
  KCS: '#24AE8F',
}

const STABLES = new Set(['USDC', 'USDBC', 'USDT', 'DAI', 'FRAX', 'USDE', 'SUSD', 'LUSD', 'GHO', 'USDS'])

export function tokenAccent(symbol: string): string {
  const key = symbol.toUpperCase()
  return TOKEN_ACCENTS[key] ?? FALLBACK_ACCENTS[hashIndex(key, FALLBACK_ACCENTS.length)]
}

/**
 * The two letters on a token's disc.
 *
 * Stables all collapse to `$`: `USDC` and `USDT` both truncate to "US", so the initials carry no
 * information anyway, and "this is a dollar" is the useful thing to see while scanning.
 */
export function tokenMono(symbol: string): string {
  const key = symbol.toUpperCase()
  if (STABLES.has(key)) return '$'
  return key.slice(0, 2) || '?'
}

/** sRGB relative luminance, per WCAG 2.1. */
function luminance(hex: string): number {
  const raw = hex.replace('#', '')
  const full = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw
  const channels = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

const INK_LIGHT = '#FFFFFF'
const INK_DARK = '#18181B'

/**
 * Which of the two inks to set a mark's glyph in.
 *
 * White wherever it still clears 3:1 — that is the look every one of these brands ships, and a
 * mark set in the brand's own contrast is the one people recognise. Only a genuinely light brand
 * (BNB's yellow, Hyperliquid's mint) flips to dark type.
 *
 * The threshold is what makes the fallback safe: white fails 3:1 only above ~0.30 luminance, and
 * dark ink on anything that light clears 5.9:1. So neither branch can produce a smudge, and no
 * hand-maintained per-colour flag can drift out of step with the palette.
 */
export function readableInk(accent: string): string {
  const onDark = (luminance(INK_LIGHT) + 0.05) / (luminance(accent) + 0.05)
  return onDark >= 3 ? INK_LIGHT : INK_DARK
}
