/**
 * Turning the sentiment feed into gauge rows.
 *
 * Separate from the panel because each model has its own scale, and getting a ceiling wrong is
 * invisible in the UI — the bar still draws, just always full or always empty. Pure functions are
 * the only way to pin that down in a test.
 */

import type { Sentiment } from './types'

interface Gauge {
  key: string
  title: string
  /** The reading itself, already formatted. */
  value: string
  /** The model's own verdict — "Greed", "Undervalued". */
  label: string
  /** 0–1, where the reading sits on the model's scale. */
  frac: number
  color: string
}

/** Fear & Greed ships no colour of its own, so the scale is reproduced here: fear red → greed green. */
function fearGreedColor(value: number): string {
  if (value < 25) return '#ff5c43'
  if (value < 45) return '#ff8a3d'
  if (value < 55) return '#f2c744'
  if (value < 75) return '#9fd64f'
  return '#54e6b4'
}

/**
 * The rainbow's own colour is the *band* it names, which is a different scale from every other
 * row here — a purple bar next to four risk-coloured ones reads as a sixth category. Re-derived
 * from the ratio on the shared fear→greed scale so the column is comparable top to bottom.
 */
function rainbowColor(ratio: number): string {
  if (ratio < 0.8) return '#54e6b4'
  if (ratio < 1.0) return '#9fd64f'
  if (ratio < 1.4) return '#f2c744'
  if (ratio < 2) return '#ff8a3d'
  return '#ff5c43'
}

const clamp = (n: number) => Math.min(1, Math.max(0, n))

/** The port of `buildMetrics`, including each model's own scale ceiling. */
export function gauges(s: Sentiment | undefined): Gauge[] {
  if (!s) return []
  const out: Gauge[] = []
  if (s.fear_greed) {
    out.push({
      key: 'fng',
      title: 'Fear & Greed',
      value: String(s.fear_greed.value),
      label: s.fear_greed.classification,
      frac: clamp(s.fear_greed.value / 100),
      color: fearGreedColor(s.fear_greed.value),
    })
  }
  if (s.mvrv_zscore) {
    out.push({
      key: 'mvrv',
      title: 'MVRV Z-Score',
      value: String(s.mvrv_zscore.value),
      label: s.mvrv_zscore.label,
      // Historic tops cluster around 7–8, so 8 is the ceiling the bar is drawn against.
      frac: clamp(s.mvrv_zscore.value / 8),
      color: s.mvrv_zscore.color || '#f2c744',
    })
  }
  if (s.btc_rainbow) {
    out.push({
      key: 'rainbow',
      title: 'BTC Rainbow',
      value: `${s.btc_rainbow.ratio}×`,
      label: s.btc_rainbow.label,
      frac: clamp(s.btc_rainbow.ratio / 2.5),
      color: rainbowColor(s.btc_rainbow.ratio),
    })
  }
  if (s.sopr) {
    out.push({
      key: 'sopr',
      title: 'SOPR',
      value: String(s.sopr.value),
      // SOPR lives in a narrow band around 1.0; the interesting range is 0.9–1.1, and drawing it
      // against 0–1 would pin every reading to the far right.
      frac: clamp((s.sopr.value - 0.9) / 0.2),
      label: s.sopr.label,
      color: s.sopr.color || '#f2c744',
    })
  }
  if (s.puell) {
    out.push({
      key: 'puell',
      title: 'Puell Multiple',
      value: String(s.puell.value),
      label: s.puell.label,
      frac: clamp(s.puell.value / 5),
      color: s.puell.color || '#f2c744',
    })
  }
  return out
}
