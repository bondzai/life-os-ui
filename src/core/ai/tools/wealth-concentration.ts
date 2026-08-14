import { registerTool, type AITool } from './registry'
import { buildWealthContext } from '../context/wealth-context'
import { getSolPrefix } from '../soul'

/**
 * Concentration and liquidation risk across the book.
 *
 * Deliberately separate from the portfolio review: concentration is the question most likely to be
 * answered with a confidently invented number, so it gets a prompt that spells out which figures
 * the judgement depends on.
 */
const tool: AITool = {
  id: 'wealth-concentration',
  name: 'Concentration Risk',
  description: 'Finds single-asset, single-chain, and liquidation concentration in the book',
  scope: 'global',
  buildPrompt: ({ wealth }) => [
    {
      role: 'system',
      content: [
        getSolPrefix(160),
        '',
        'Assess concentration risk across three axes:',
        '- Single asset: how much of net worth rides on one token.',
        '- Single chain or venue: what one chain halt or one exchange failure would reach.',
        '- Leverage: how close any borrow position sits to liquidation.',
        '',
        'A concentration claim needs both the position size and net worth. If either is',
        'UNAVAILABLE, say the concentration cannot be computed rather than quoting a share that',
        'rests on a guess. Health factors near 1.0 are urgent; a null health factor means there is',
        'no debt, which is safe — not unknown.',
        '',
        'Correlation counts: assets that move together are one exposure, not several.',
        '',
        buildWealthContext(wealth ?? null),
      ].join('\n'),
    },
    { role: 'user', content: 'Where is my concentration risk?' },
  ],
}

registerTool(tool)
