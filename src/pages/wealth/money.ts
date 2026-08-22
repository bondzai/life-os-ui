/**
 * The display currency, and the one formatter every wealth surface renders money through.
 *
 * The book is *computed* in USD and only ever *displayed* in something else: every stored figure,
 * every derivation and every server response stays USD, and the conversion happens at the last
 * possible moment. Converting earlier would mean a rate move silently rewriting derived numbers —
 * tier splits, APRs, P&L — that were never denominated in the display currency at all.
 *
 * `sats` is not a currency but a BTC amount, which is the point of having it: it is the unit that
 * keeps a stacker honest about whether the stack grew, independent of price.
 */

import { useCallback, useSyncExternalStore } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useAuthStore } from '@/stores/auth-store'
import { WEALTH_SOURCE } from './use-wealth'
import { formatAmount } from './format'
import type { Currency, Rates } from './types'

export const CURRENCIES: Currency[] = ['usd', 'thb', 'sats']
const KEY = 'lyra:wealth:currency'

function isCurrency(value: unknown): value is Currency {
  return typeof value === 'string' && (CURRENCIES as string[]).includes(value)
}

/**
 * A module-level store rather than React state, for the same reason the clock in `use-wealth` is
 * one: the choice is global to the session, and threading it through props would mean every
 * component that renders a number takes a currency it does not otherwise care about.
 */
const store = {
  listeners: new Set<() => void>(),
  current: ((): Currency => {
    try {
      const stored = localStorage.getItem(KEY)
      return isCurrency(stored) ? stored : 'usd'
    } catch {
      return 'usd'
    }
  })(),
  subscribe(onChange: () => void): () => void {
    store.listeners.add(onChange)
    return () => store.listeners.delete(onChange)
  },
  getSnapshot: (): Currency => store.current,
  set(next: Currency): void {
    if (next === store.current) return
    store.current = next
    try {
      localStorage.setItem(KEY, next)
    } catch {
      // A browser with storage disabled still gets the switch, just not across reloads.
    }
    for (const listener of store.listeners) listener()
  },
}

/**
 * The live FX rates, read from the same cache entry the portfolio surfaces use.
 *
 * The identical query key means react-query serves the already-fetched snapshot rather than
 * firing a second multi-chain fan-out, and a component deep in a card re-renders when the rate
 * moves without being handed `rates` through six layers of props.
 */
export function useRates(): Rates | null {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated)
  const { data } = useQuery({
    queryKey: ['wealth', 'portfolio'],
    queryFn: () => WEALTH_SOURCE.getPortfolio(),
    enabled: isAuthenticated,
    staleTime: 60_000,
    retry: false,
  })
  return data?.rates ?? null
}

/** USD into the display currency, or `null` when the rate needed is missing. */
export function toDisplay(usd: number, currency: Currency, rates: Rates | null): number | null {
  if (currency === 'usd') return usd
  if (currency === 'thb') {
    const thb = rates?.thb
    return typeof thb === 'number' && thb > 0 ? usd * thb : null
  }
  const btcUsd = rates?.btc_usd
  return typeof btcUsd === 'number' && btcUsd > 0 ? (usd / btcUsd) * 100_000_000 : null
}

function group(value: number, digits: number): string {
  return value.toLocaleString('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function abbreviate(value: number): string {
  const abs = Math.abs(value)
  if (abs >= 1e9) return `${(value / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(value / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `${(value / 1e3).toFixed(1)}k`
  return value.toFixed(0)
}

/**
 * Money in the display currency.
 *
 * A missing rate renders `—`, never the USD figure under a THB label: at ~33 THB to the dollar
 * that would understate net worth thirty-fold while looking entirely plausible.
 *
 * Sats are whole numbers — a fractional satoshi does not exist — and THB drops to whole baht above
 * a thousand, where the satang are noise.
 */
export function formatMoney(
  usd: number | null | undefined,
  currency: Currency,
  rates: Rates | null,
  opts: { compact?: boolean } = {},
): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—'
  const value = toDisplay(usd, currency, rates)
  if (value === null) return '—'

  // The sign goes **outside** the symbol. Formatting the signed number and prefixing the symbol
  // produces "$-1,234.50", which reads as a currency nobody has heard of; every locale writes
  // this as "-$1,234.50". Format the magnitude, then re-attach the sign.
  const abs = Math.abs(value)
  const sign = value < 0 ? '-' : ''

  if (opts.compact && abs >= 10_000) {
    if (currency === 'sats') return `${sign}${abbreviate(abs)} sats`
    return `${sign}${currency === 'thb' ? '฿' : '$'}${abbreviate(abs)}`
  }
  if (currency === 'sats') return `${sign}${group(abs, 0)} sats`
  if (currency === 'thb') return `${sign}฿${group(abs, abs >= 1000 ? 0 : 2)}`

  // USD keeps the sub-cent precision the tables were built around: a $0.0239 fee row reading
  // "$0.02" loses the only digits that distinguished it from zero.
  return `${sign}$${group(abs, abs < 1 && abs > 0 ? 4 : 2)}`
}

export interface Money {
  currency: Currency
  setCurrency: (next: Currency) => void
  rates: Rates | null
  /** Full precision — tables, rows, anything that has to add up on screen. */
  money: (usd: number | null | undefined) => string
  /** Abbreviated above 10k — headline figures and axis labels. */
  compact: (usd: number | null | undefined) => string
  /** Signed, for deltas where direction carries the meaning. */
  signed: (usd: number | null | undefined) => string
  /** The symbol alone, for input adornments. Empty for sats, which suffixes instead. */
  symbol: string
}

/** Everything a component needs to render money in the user's chosen unit. */
export function useMoney(): Money {
  const currency = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  const rates = useRates()

  const money = useCallback(
    (usd: number | null | undefined) => formatMoney(usd, currency, rates),
    [currency, rates],
  )
  const compact = useCallback(
    (usd: number | null | undefined) => formatMoney(usd, currency, rates, { compact: true }),
    [currency, rates],
  )
  const signed = useCallback(
    (usd: number | null | undefined) => {
      if (usd === null || usd === undefined || !Number.isFinite(usd)) return '—'
      const body = formatMoney(Math.abs(usd), currency, rates)
      return body === '—' ? body : `${usd >= 0 ? '+' : '−'}${body}`
    },
    [currency, rates],
  )

  return {
    currency,
    setCurrency: store.set,
    rates,
    money,
    compact,
    signed,
    symbol: currency === 'thb' ? '฿' : currency === 'sats' ? '' : '$',
  }
}

/** Token amounts are never converted — a balance of 14.2 ETH is 14.2 ETH in any currency. */
export { formatAmount }
