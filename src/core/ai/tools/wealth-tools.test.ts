/**
 * Registration and prompt-shape tests for the wealth tools.
 *
 * Registration happens as an import side effect, so a tool that is written but never imported in
 * `index.ts` simply does not exist at runtime — with no error anywhere. That is worth a test.
 *
 * The prompt assertions deliberately check for the data-discipline block rather than the wording
 * of the analysis instructions: the prose can be tuned freely, but a wealth prompt that reaches
 * the model without the UNAVAILABLE rules is a correctness bug.
 */

import { describe, expect, it } from 'vitest'
import './index'
import { getAllTools, getTool, getToolsForScope } from './registry'
import { UNAVAILABLE } from '../context/wealth-envelope'
import type { WealthBrief } from '../context/wealth-context'

const WEALTH_TOOL_IDS = [
  'wealth-portfolio-review',
  'wealth-tier-drift',
  'wealth-lp-health',
  'wealth-concentration',
]

function brief(overrides: Partial<WealthBrief> = {}): WealthBrief {
  return {
    netWorthUsd: 100_000,
    change24hPct: 1.5,
    debtUsd: 0,
    ageSeconds: 60,
    isStale: false,
    tierUsd: { store: 50_000, business: 30_000, trading: 20_000 },
    targetTierPct: null,
    topHoldings: [],
    lps: [],
    lending: [],
    windows: [],
    claimableUsd: 0,
    dataGaps: [],
    ...overrides,
  }
}

const params = (wealth?: WealthBrief) => ({ entities: [], trackers: [], wealth })

/**
 * Collapses whitespace before matching.
 *
 * The prompts are authored as wrapped line arrays, so a phrase can straddle a newline. Asserting
 * against flattened text keeps these tests about the *instruction* rather than the line width,
 * and lets the prose be rewrapped without breaking them.
 */
const flat = (text: string) => text.replace(/\s+/g, ' ')

const systemOf = (id: string, wealth?: WealthBrief) =>
  getTool(id)!.buildPrompt(params(wealth)).find((m) => m.role === 'system')!.content

describe('wealth tool registration', () => {
  it('registers every wealth tool', () => {
    for (const id of WEALTH_TOOL_IDS) {
      expect(getTool(id), `${id} is not registered — is it imported in index.ts?`).toBeDefined()
    }
  })

  it('does not collide with the existing tools', () => {
    const ids = getAllTools().map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('analyze-risk')
  })

  it('offers the LP tool on wallet and asset entities', () => {
    expect(getToolsForScope('wallet').map((t) => t.id)).toContain('wealth-lp-health')
    expect(getToolsForScope('asset').map((t) => t.id)).toContain('wealth-lp-health')
  })

  it('offers the whole-book tools everywhere, since they read across wallets', () => {
    const onATask = getToolsForScope('task').map((t) => t.id)
    expect(onATask).toContain('wealth-portfolio-review')
    expect(onATask).toContain('wealth-concentration')
    expect(onATask).toContain('wealth-tier-drift')
  })
})

describe('wealth tool prompts', () => {
  it.each(WEALTH_TOOL_IDS)('%s carries the data rules', (id) => {
    const system = systemOf(id, brief())
    expect(system).toContain('DATA RULES')
    expect(system).toContain('does NOT mean zero')
    expect(system).toContain('DATA GAPS')
  })

  it.each(WEALTH_TOOL_IDS)('%s still builds a usable prompt with no wealth data', (id) => {
    // The tool may be invoked before the portfolio loads. It must say so rather than render a
    // prompt full of blanks the model would fill in.
    const messages = getTool(id)!.buildPrompt(params(undefined))
    const system = messages.find((m) => m.role === 'system')!.content
    expect(system).toContain(UNAVAILABLE)
    expect(system).toContain('DATA RULES')
    expect(messages.some((m) => m.role === 'user')).toBe(true)
  })

  it('tells the drift tool not to invent a target allocation', () => {
    const system = flat(systemOf('wealth-tier-drift', brief()))
    expect(system).toContain('do NOT substitute a textbook split')
    expect(system).toContain('a number the user never chose')
  })

  it('tells the LP tool not to read APR as evidence of earning', () => {
    const system = flat(systemOf('wealth-lp-health', brief()))
    expect(system).toContain('an out-of-range position earns nothing')
    expect(system).toContain('Time-in-range is the honest signal')
  })

  it('surfaces a stale snapshot into the prompt body', () => {
    const system = systemOf('wealth-portfolio-review', brief({ isStale: true, ageSeconds: 4000 }))
    expect(system).toContain('STALE')
  })
})
