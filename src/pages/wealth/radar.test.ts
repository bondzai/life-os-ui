/**
 * The Radar gauges.
 *
 * Each model has its own scale, and getting a ceiling wrong is invisible: the bar still draws,
 * just always full or always empty. SOPR is the sharp one — it lives in a narrow band around 1.0,
 * so a naive 0–1 scale pins every reading to the far right and the panel looks broken-but-plausible.
 */

import { describe, expect, it } from 'vitest'
import { gauges } from './radar-gauges'

describe('gauges', () => {
  it('is empty when nothing answered', () => {
    expect(gauges(undefined)).toEqual([])
    expect(gauges({})).toEqual([])
  })

  it('keeps whichever models did answer', () => {
    const only = gauges({ fear_greed: { value: 71, classification: 'Greed' } })
    expect(only).toHaveLength(1)
    expect(only[0]).toMatchObject({ key: 'fng', value: '71', label: 'Greed' })
    expect(only[0].frac).toBeCloseTo(0.71, 5)
  })

  it('draws SOPR against its real band, not 0–1', () => {
    // 1.018 is mild profit-taking, a little above the middle — not 100%.
    const [sopr] = gauges({ sopr: { value: 1.018, label: 'Profit-taking' } })
    expect(sopr.frac).toBeCloseTo(0.59, 2)
    // The band's edges clamp rather than run off either end.
    expect(gauges({ sopr: { value: 0.5, label: 'Capitulation' } })[0].frac).toBe(0)
    expect(gauges({ sopr: { value: 2, label: 'Euphoria' } })[0].frac).toBe(1)
  })

  it('scales each remaining model by its own ceiling', () => {
    expect(gauges({ mvrv_zscore: { value: 4, label: 'Fair' } })[0].frac).toBeCloseTo(0.5, 5)
    expect(gauges({ btc_rainbow: { ratio: 1.25, label: 'Hold' } })[0].frac).toBeCloseTo(0.5, 5)
    expect(gauges({ puell: { value: 2.5, label: 'Fair' } })[0].frac).toBeCloseTo(0.5, 5)
  })

  it('never runs past the end of a bar', () => {
    for (const g of gauges({
      mvrv_zscore: { value: 99, label: 'Top' },
      btc_rainbow: { ratio: 99, label: 'Maximum bubble' },
      puell: { value: 99, label: 'Top' },
    })) {
      expect(g.frac).toBe(1)
    }
  })

  /** A purple band colour beside four risk-coloured bars reads as a sixth category. */
  it('re-derives the rainbow colour onto the shared risk scale', () => {
    const [cheap] = gauges({ btc_rainbow: { ratio: 0.291, label: 'Fire sale', color: '#5b4bbf' } })
    expect(cheap.color).not.toBe('#5b4bbf')
    expect(cheap.color).toBe('#54e6b4')
    const [rich] = gauges({ btc_rainbow: { ratio: 2.2, label: 'Bubble', color: '#5b4bbf' } })
    expect(rich.color).toBe('#ff5c43')
  })

  /** Every other model ships its own colour, and that one is the model's own verdict. */
  it('keeps the colour a model supplies', () => {
    const [mvrv] = gauges({ mvrv_zscore: { value: 0.69, label: 'Undervalued', color: '#2bb3a3' } })
    expect(mvrv.color).toBe('#2bb3a3')
  })
})
