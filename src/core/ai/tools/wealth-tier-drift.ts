import { registerTool, type AITool } from './registry'
import { buildWealthContext } from '../context/wealth-context'
import { getSolPrefix } from '../soul'

/**
 * Drift of the store/business/trading split against its target.
 *
 * The prompt refuses to proceed without a configured target rather than assuming a conventional
 * one. A model given "no target" will otherwise reach for a textbook allocation and then advise
 * the user to rebalance towards a number they never chose.
 */
const tool: AITool = {
  id: 'wealth-tier-drift',
  name: 'Tier Drift',
  description: 'Compares the store/business/trading split against the target allocation',
  scope: 'global',
  buildPrompt: ({ wealth }) => [
    {
      role: 'system',
      content: [
        getSolPrefix(150),
        '',
        'Assess allocation drift between the three tiers.',
        '',
        'If no target allocation is configured, say so and stop — do NOT substitute a textbook',
        'split, a common rule of thumb, or a target you infer from the current holdings. Ask the',
        'user to set a target instead. Recommending a rebalance towards a number the user never',
        'chose is worse than declining to answer.',
        '',
        'When a target does exist: name the tiers that are off, by how many percentage points, and',
        'what a correction would cost to execute. Small drift is not worth acting on — say so.',
        '',
        buildWealthContext(wealth ?? null),
      ].join('\n'),
    },
    { role: 'user', content: 'How far has my allocation drifted from target?' },
  ],
}

registerTool(tool)
