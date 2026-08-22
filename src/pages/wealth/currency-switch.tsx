/**
 * USD · THB · SATS — the display-currency switch.
 *
 * Lives in the top bar rather than on a settings page, as it did in the original: this is a lens
 * you flip while reading, not a preference you configure once. It renders only on wealth routes,
 * because a currency control above a task list is noise.
 */

import { useMoney, CURRENCIES } from './money'
import { cn } from '@/lib/utils'

export function CurrencySwitch() {
  const { currency, setCurrency, rates } = useMoney()

  return (
    <div
      role="group"
      aria-label="Display currency"
      className="inline-flex shrink-0 items-center rounded-md border bg-muted/50 p-0.5"
    >
      {CURRENCIES.map((code) => {
        // A rate this box has not got means the whole surface would render em-dashes, so the
        // option is disabled and says why rather than quietly blanking every number.
        const missing =
          (code === 'thb' && typeof rates?.thb !== 'number') ||
          (code === 'sats' && typeof rates?.btc_usd !== 'number')
        return (
          <button
            key={code}
            type="button"
            aria-pressed={currency === code}
            disabled={missing}
            title={missing ? `No ${code.toUpperCase()} rate available right now` : undefined}
            onClick={() => setCurrency(code)}
            className={cn(
              'rounded px-2 py-1 text-xs font-medium uppercase tracking-wide transition-colors',
              currency === code
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground',
              missing && 'cursor-not-allowed opacity-40 hover:text-muted-foreground',
            )}
          >
            {code}
          </button>
        )
      })}
    </div>
  )
}
