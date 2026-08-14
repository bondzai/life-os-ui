import type { Detector, Insight } from './types'

/** A day's move has to clear this to be worth a line in the brief. */
export const MOVE_PCT_THRESHOLD = 5
/** Above this, it leads the brief. */
export const MOVE_PCT_CRITICAL = 10

/**
 * A net-worth move worth knowing about on waking.
 *
 * Fires on the 24h change only when it is genuinely large — the point of the brief is that
 * everything in it deserves attention, and a 1% wobble does not.
 *
 * Silent when the change is unavailable rather than reporting 0%: an absent price feed is not a
 * flat day, and a brief line saying "net worth flat" would be a false statement about the user's
 * money. The gap surfaces in the AI prompts instead, which are built to explain it.
 */
export const detectNetWorthMove: Detector = ({ wealth }) => {
  const insights: Insight[] = []
  if (!wealth) return insights

  const { change24hPct, netWorthUsd, isStale } = wealth
  if (change24hPct === null || netWorthUsd === null) return insights
  // A stale snapshot's "24h change" is a window that ended some time ago; presenting it as this
  // morning's move would be wrong in exactly the way the brief must not be.
  if (isStale) return insights

  const magnitude = Math.abs(change24hPct)
  if (magnitude < MOVE_PCT_THRESHOLD) return insights

  const up = change24hPct > 0
  const deltaUsd = Math.abs(netWorthUsd * (change24hPct / 100))

  insights.push({
    id: 'wealth-networth-move',
    type: up ? 'info' : 'warning',
    category: 'wealth',
    severity: magnitude >= MOVE_PCT_CRITICAL ? 3 : 2,
    title: `Net worth ${up ? 'up' : 'down'} ${magnitude.toFixed(1)}% in 24h`,
    detail: `${up ? '+' : '−'}$${deltaUsd.toFixed(0)} to $${netWorthUsd.toFixed(0)}`,
    actionLabel: 'View',
    actionPath: '/wealth',
    data: { changePct: change24hPct, netWorthUsd, deltaUsd, direction: up ? 'up' : 'down' },
  })

  return insights
}
