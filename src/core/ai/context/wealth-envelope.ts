/**
 * The missing-data discipline for every wealth prompt.
 *
 * A local LLM states things confidently. If a figure is simply left out of a prompt, the model
 * does not read that as "unknown" — it reads it as zero, or as unchanged, and then asserts
 * something false about the user's actual money. "Your trading tier is empty" and "I could not
 * read your trading tier" are the same prompt to a model that only sees an absent line.
 *
 * So nothing here is ever omitted. Every figure renders as a real number *or* the literal token
 * `UNAVAILABLE`, every unavailable figure is also collected into an explicit data-gaps list, and
 * the prompt carries standing rules telling the model what those tokens mean. This mirrors the
 * `{value, confidence, data_gaps}` envelope the Rust analytics layer carries, for the same reason.
 *
 * Everything in this file is pure and unit-tested — it is the part that must not rot.
 */

/** Whether a figure can be trusted as current. */
export type FigureState = 'ok' | 'stale' | 'missing'

export type FigureUnit = 'usd' | 'pct' | 'ratio' | 'count' | 'text'

export interface Figure {
  label: string
  /** `null`/`undefined`/`NaN` all mean "could not be read" — never "zero". */
  value: number | string | null | undefined
  unit?: FigureUnit
  /**
   * Why the value is missing or stale. Shown to the model, so write it as an explanation a
   * reader can act on ("no target allocation configured"), not an error code.
   */
  note?: string
  /** Forces `stale` on a figure that is present but no longer current. */
  state?: FigureState
}

/** The single token the model is taught to recognise. Never change it without the prompt rules. */
export const UNAVAILABLE = 'UNAVAILABLE'

/**
 * The standing rules every wealth prompt carries.
 *
 * Stated as prohibitions rather than suggestions because the failure mode is confident invention,
 * and a model that is merely *encouraged* to flag gaps will still fill them.
 */
export const DATA_RULES = [
  'DATA RULES — these override any instinct to be helpful:',
  `- Every figure below is either a real number or the literal token ${UNAVAILABLE}.`,
  `- ${UNAVAILABLE} means the value could not be read. It does NOT mean zero, it does NOT mean`,
  '  unchanged, and it does NOT mean the user holds none. Never infer, estimate, interpolate, or',
  '  substitute a number for it.',
  `- Never include an ${UNAVAILABLE} figure in a sum, percentage, ratio, or comparison. If an`,
  '  input to a calculation is missing, say the calculation cannot be made and move on.',
  '- Figures marked STALE were true at the age shown, not now. Say "as of" when you use one, and',
  '  never describe a stale figure as the current position.',
  '- If the DATA GAPS section is non-empty, mention the gaps that affect your answer before your',
  '  conclusions, so the user knows what you could not see.',
  '- This is the user\'s real money. An admitted gap is useful; a confident wrong number is not.',
].join('\n')

/** How old a figure may be before it is called out as stale. Matches `STALE_WARN_SECONDS`. */
export const STALE_AFTER_SECONDS = 15 * 60

function isMissing(value: Figure['value']): boolean {
  if (value === null || value === undefined) return true
  if (typeof value === 'number') return !Number.isFinite(value)
  return value.trim() === ''
}

/** A figure's trust level: an explicit `state` wins, otherwise presence decides. */
export function figureState(figure: Figure): FigureState {
  if (isMissing(figure.value)) return 'missing'
  return figure.state === 'stale' ? 'stale' : 'ok'
}

const usdFormat = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
})

/** Formats a present value. Callers must have already excluded the missing case. */
export function formatValue(value: number | string, unit: FigureUnit = 'text'): string {
  if (typeof value === 'string') return value
  switch (unit) {
    case 'usd':
      return usdFormat.format(value)
    case 'pct':
      // Signed, because a wealth prompt is almost always about direction.
      return `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
    case 'ratio':
      return value.toFixed(2)
    case 'count':
      return String(Math.round(value))
    default:
      return String(value)
  }
}

/** Human-readable age, used to make staleness concrete rather than a bare flag. */
export function formatAge(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return UNAVAILABLE
  const s = Math.max(0, Math.round(seconds))
  if (s < 90) return `${s}s old`
  if (s < 5400) return `${Math.round(s / 60)}m old`
  if (s < 172800) return `${Math.round(s / 3600)}h old`
  return `${Math.round(s / 86400)}d old`
}

/** One rendered line, plus the gap it contributes (if any). */
export interface RenderedFigure {
  line: string
  gap: string | null
}

/**
 * Renders one figure, never omitting it.
 *
 * A missing figure still occupies a line — that is the whole point. Silence is what the model
 * misreads; an explicit `UNAVAILABLE` is not.
 */
export function renderFigure(figure: Figure): RenderedFigure {
  const state = figureState(figure)

  if (state === 'missing') {
    const reason = figure.note?.trim() || 'not available in this snapshot'
    return {
      line: `${figure.label}: ${UNAVAILABLE} (${reason})`,
      gap: `${figure.label} — ${reason}`,
    }
  }

  const rendered = formatValue(figure.value as number | string, figure.unit)
  if (state === 'stale') {
    const reason = figure.note?.trim() || 'age unknown'
    return {
      line: `${figure.label}: ${rendered} [STALE: ${reason}]`,
      gap: `${figure.label} is stale (${reason}) — treat as "as of", not current`,
    }
  }

  const suffix = figure.note?.trim() ? ` (${figure.note.trim()})` : ''
  return { line: `${figure.label}: ${rendered}${suffix}`, gap: null }
}

export interface RenderedSection {
  text: string
  gaps: string[]
}

/** Renders a titled block of figures and collects everything the model must not assume about. */
export function renderSection(title: string, figures: Figure[]): RenderedSection {
  const rendered = figures.map(renderFigure)
  return {
    text: [`${title}:`, ...rendered.map((r) => `  ${r.line}`)].join('\n'),
    gaps: rendered.map((r) => r.gap).filter((g): g is string => g !== null),
  }
}

/**
 * The data-gaps block.
 *
 * Rendered even when empty — an explicit "none" is a much stronger signal than an absent section,
 * which the model would otherwise have to interpret.
 */
export function renderDataGaps(gaps: string[]): string {
  if (gaps.length === 0) {
    return 'DATA GAPS: none — every figure above was read successfully.'
  }
  return ['DATA GAPS — do not reason past these:', ...gaps.map((g) => `  - ${g}`)].join('\n')
}

/**
 * Accumulates sections and their gaps so the gaps list can never drift out of step with the
 * figures that produced it.
 */
export class EnvelopeBuilder {
  private readonly blocks: string[] = []
  private readonly gaps: string[] = []

  section(title: string, figures: Figure[]): this {
    const { text, gaps } = renderSection(title, figures)
    this.blocks.push(text)
    this.gaps.push(...gaps)
    return this
  }

  /** Free-form prose that is not a figure (a list of positions, a caveat). */
  text(block: string): this {
    if (block.trim()) this.blocks.push(block)
    return this
  }

  /** A gap with no figure of its own — e.g. an entire section that could not be built. */
  gap(description: string): this {
    this.gaps.push(description)
    return this
  }

  dataGaps(): string[] {
    return [...this.gaps]
  }

  /** The finished prompt body: figures, then gaps, then the rules that interpret both. */
  render(): string {
    return [...this.blocks, '', renderDataGaps(this.gaps), '', DATA_RULES].join('\n')
  }
}
