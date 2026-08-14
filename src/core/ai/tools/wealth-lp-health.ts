import { registerTool, type AITool } from './registry'
import { buildWealthContext } from '../context/wealth-context'
import { getSolPrefix } from '../soul'

/**
 * LP position health: range status, real earning time, and whether a position still pays.
 *
 * The prompt leans on time-in-range rather than APR, because an out-of-range position advertises
 * an APR it is not earning — the number is real and the yield is zero.
 */
const tool: AITool = {
  id: 'wealth-lp-health',
  name: 'LP Position Health',
  description: 'Checks liquidity positions for range, real earning time, and claimable fees',
  scope: ['wallet', 'asset'],
  buildPrompt: ({ wealth }) => [
    {
      role: 'system',
      content: [
        getSolPrefix(160),
        '',
        'Assess the liquidity positions.',
        '',
        'Judge each on whether it is actually earning, not on its advertised APR: an out-of-range',
        'position earns nothing while its APR still reads high. Time-in-range is the honest signal.',
        'Where range status or time-in-range is UNAVAILABLE, say the position cannot be assessed —',
        'do not fall back to the APR to imply it is performing.',
        '',
        'Flag: positions out of range, positions with meaningful uncollected fees, and positions',
        'whose range is narrow enough that they will drift out again soon.',
        '',
        buildWealthContext(wealth ?? null),
      ].join('\n'),
    },
    { role: 'user', content: 'How healthy are my LP positions?' },
  ],
}

registerTool(tool)
