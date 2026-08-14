import { registerTool, type AITool } from './registry'
import { buildWealthContext } from '../context/wealth-context'
import { getSolPrefix } from '../soul'

/**
 * A whole-book review: what changed, what it means, what to do.
 *
 * Scoped globally rather than to `wallet`, because the useful reading is across every wallet and
 * the off-chain assets at once — a per-wallet review would keep re-describing slices of one book.
 */
const tool: AITool = {
  id: 'wealth-portfolio-review',
  name: 'Portfolio Review',
  description: 'Reviews the whole book — allocation, trend, risks, and what to act on',
  scope: 'global',
  buildPrompt: ({ wealth }) => [
    {
      role: 'system',
      content: [
        getSolPrefix(180),
        '',
        'Review this portfolio. Work in this order:',
        '- What actually changed, and whether it is signal or noise.',
        '- Where the concentration and the leverage sit.',
        '- The one or two things worth doing, with the reason attached.',
        '',
        'Do not restate the numbers back as a list — the user can already see them. Say what they',
        'mean. If the data gaps below prevent a judgement you would otherwise make, say which',
        'judgement you are withholding and why.',
        '',
        buildWealthContext(wealth ?? null),
      ].join('\n'),
    },
    { role: 'user', content: 'Review my portfolio.' },
  ],
}

registerTool(tool)
