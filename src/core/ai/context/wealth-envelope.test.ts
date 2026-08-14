/**
 * Tests for the missing-data discipline.
 *
 * The failure this guards against is silent: a prompt that omits a figure still reads perfectly,
 * and the model then asserts a number the user never had. So the assertions here are mostly about
 * what must be *present* in the output — the literal UNAVAILABLE token, the gap entry, the reason.
 */

import { describe, expect, it } from 'vitest'
import {
  DATA_RULES,
  EnvelopeBuilder,
  UNAVAILABLE,
  figureState,
  formatAge,
  formatValue,
  renderDataGaps,
  renderFigure,
  renderSection,
} from './wealth-envelope'

describe('figureState', () => {
  it('treats every flavour of absent as missing, and zero as present', () => {
    expect(figureState({ label: 'x', value: null })).toBe('missing')
    expect(figureState({ label: 'x', value: undefined })).toBe('missing')
    expect(figureState({ label: 'x', value: NaN })).toBe('missing')
    expect(figureState({ label: 'x', value: Infinity })).toBe('missing')
    expect(figureState({ label: 'x', value: '' })).toBe('missing')
    expect(figureState({ label: 'x', value: '   ' })).toBe('missing')

    // The distinction the whole module exists for: a real zero is data, not a gap.
    expect(figureState({ label: 'x', value: 0 })).toBe('ok')
  })

  it('honours an explicit stale marking on a present value', () => {
    expect(figureState({ label: 'x', value: 5, state: 'stale' })).toBe('stale')
    // Stale is meaningless without a value — missing wins.
    expect(figureState({ label: 'x', value: null, state: 'stale' })).toBe('missing')
  })
})

describe('renderFigure', () => {
  it('renders a missing figure as UNAVAILABLE with a reason, never as an omission', () => {
    const { line, gap } = renderFigure({
      label: 'Net worth',
      value: null,
      unit: 'usd',
      note: 'no snapshot loaded',
    })
    expect(line).toBe(`Net worth: ${UNAVAILABLE} (no snapshot loaded)`)
    expect(gap).toBe('Net worth — no snapshot loaded')
  })

  it('still explains itself when no reason was supplied', () => {
    const { line, gap } = renderFigure({ label: 'APR', value: null })
    expect(line).toContain(UNAVAILABLE)
    expect(line).toContain('not available in this snapshot')
    expect(gap).not.toBeNull()
  })

  it('never renders a missing number as zero', () => {
    const { line } = renderFigure({ label: 'Debt', value: null, unit: 'usd' })
    expect(line).not.toContain('$0')
    expect(line).toContain(UNAVAILABLE)
  })

  it('marks a stale figure as stale and raises a gap for it', () => {
    const { line, gap } = renderFigure({
      label: 'Net worth',
      value: 1000,
      unit: 'usd',
      state: 'stale',
      note: '47m old',
    })
    expect(line).toBe('Net worth: $1,000.00 [STALE: 47m old]')
    expect(gap).toContain('stale')
  })

  it('reports a healthy figure with no gap', () => {
    const { line, gap } = renderFigure({ label: '24h change', value: 2.41, unit: 'pct' })
    expect(line).toBe('24h change: +2.4%')
    expect(gap).toBeNull()
  })

  it('renders a real zero as a number, with no gap', () => {
    const { line, gap } = renderFigure({ label: 'Debt', value: 0, unit: 'usd' })
    expect(line).toBe('Debt: $0.00')
    expect(gap).toBeNull()
  })
})

describe('formatValue', () => {
  it('signs percentages so direction survives into the prompt', () => {
    expect(formatValue(2.44, 'pct')).toBe('+2.4%')
    expect(formatValue(-2.44, 'pct')).toBe('-2.4%')
    expect(formatValue(0, 'pct')).toBe('+0.0%')
  })

  it('formats the other units predictably', () => {
    expect(formatValue(1234.5, 'usd')).toBe('$1,234.50')
    expect(formatValue(1.945, 'ratio')).toBe('1.95')
    expect(formatValue(3.7, 'count')).toBe('4')
    expect(formatValue('in range')).toBe('in range')
  })
})

describe('formatAge', () => {
  it('scales the unit to the age', () => {
    expect(formatAge(30)).toBe('30s old')
    expect(formatAge(600)).toBe('10m old')
    expect(formatAge(7200)).toBe('2h old')
    expect(formatAge(3 * 86400)).toBe('3d old')
  })

  it('says UNAVAILABLE rather than inventing an age', () => {
    expect(formatAge(null)).toBe(UNAVAILABLE)
    expect(formatAge(undefined)).toBe(UNAVAILABLE)
    expect(formatAge(NaN)).toBe(UNAVAILABLE)
  })
})

describe('renderSection', () => {
  it('keeps every figure and collects only the gaps', () => {
    const { text, gaps } = renderSection('Portfolio', [
      { label: 'Net worth', value: 100, unit: 'usd' },
      { label: 'Debt', value: null, unit: 'usd', note: 'lending feed down' },
    ])
    expect(text).toContain('Net worth: $100.00')
    expect(text).toContain(`Debt: ${UNAVAILABLE}`)
    expect(gaps).toEqual(['Debt — lending feed down'])
  })
})

describe('renderDataGaps', () => {
  it('states explicitly that there are none, rather than rendering nothing', () => {
    // An absent section would leave the model to infer whether gaps were checked for at all.
    expect(renderDataGaps([])).toContain('none')
  })

  it('lists gaps under a heading that forbids reasoning past them', () => {
    const text = renderDataGaps(['Debt — feed down'])
    expect(text).toContain('DATA GAPS')
    expect(text).toContain('- Debt — feed down')
  })
})

describe('DATA_RULES', () => {
  it('tells the model what UNAVAILABLE does and does not mean', () => {
    expect(DATA_RULES).toContain(UNAVAILABLE)
    expect(DATA_RULES).toContain('does NOT mean zero')
    expect(DATA_RULES).toContain('Never infer')
  })

  it('forbids arithmetic over a missing value', () => {
    expect(DATA_RULES.toLowerCase()).toContain('never include an unavailable figure in a sum')
  })
})

describe('EnvelopeBuilder', () => {
  it('always ends with the gaps and the rules that interpret them', () => {
    const out = new EnvelopeBuilder()
      .section('Portfolio', [{ label: 'Net worth', value: 100, unit: 'usd' }])
      .render()

    expect(out).toContain('Net worth: $100.00')
    expect(out).toContain('DATA GAPS')
    expect(out).toContain('DATA RULES')
    expect(out.indexOf('DATA GAPS')).toBeLessThan(out.indexOf('DATA RULES'))
  })

  it('accumulates gaps from every section plus any added directly', () => {
    const builder = new EnvelopeBuilder()
      .section('A', [{ label: 'x', value: null, note: 'reason one' }])
      .section('B', [{ label: 'y', value: null, note: 'reason two' }])
      .gap('a whole section could not be built')

    expect(builder.dataGaps()).toHaveLength(3)
    const out = builder.render()
    expect(out).toContain('reason one')
    expect(out).toContain('reason two')
    expect(out).toContain('a whole section could not be built')
  })

  it('cannot drift out of step with the figures that produced the gaps', () => {
    // Every UNAVAILABLE line must have a matching gap entry — that pairing is the invariant.
    const builder = new EnvelopeBuilder().section('Portfolio', [
      { label: 'a', value: null },
      { label: 'b', value: 1 },
      { label: 'c', value: null },
    ])
    const out = builder.render()
    const unavailableLines = out.split('\n').filter((l) => l.includes(`: ${UNAVAILABLE}`))
    expect(unavailableLines).toHaveLength(2)
    expect(builder.dataGaps()).toHaveLength(2)
  })
})
