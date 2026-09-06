/**
 * Money/percent/token formatting for the wealth surfaces.
 *
 * Centralised because inconsistent rounding across panels reads as a data bug: if the Overview
 * says $12.3k and Holdings adds up to $12,347.02, the user cannot tell which one is lying.
 */

import type { Currency, Rates } from './types'

/** Compact for headline figures — full precision belongs in tables, not on a hero number. */
export function formatUsd(value: number | null | undefined, opts: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const abs = Math.abs(value)
  if (opts.compact && abs >= 10_000) {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      notation: 'compact',
      maximumFractionDigits: 1,
    }).format(value)
  }
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    // Sub-cent balances are dust; showing 6 decimals on them just adds noise.
    maximumFractionDigits: abs < 1 ? 4 : 2,
    minimumFractionDigits: abs < 1 ? 0 : 2,
  }).format(value)
}

/**
 * Percent with an explicit sign, because these are almost always deltas and a bare "2.1%"
 * next to a red arrow is ambiguous about direction.
 */
export function formatPct(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  const sign = value > 0 ? '+' : ''
  return `${sign}${value.toFixed(digits)}%`
}

/** Token amounts scale over ~12 orders of magnitude, so precision has to be adaptive. */
export function formatAmount(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—'
  const abs = Math.abs(amount)
  if (abs === 0) return '0'
  if (abs >= 1_000_000) return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 2 }).format(amount)
  if (abs >= 1) return amount.toLocaleString('en-US', { maximumFractionDigits: 4 })
  if (abs >= 0.0001) return amount.toFixed(6)
  return amount.toExponential(2)
}

/** Shortens `0xabcd…1234` for display without losing the identifying ends. */
export function shortAddress(address: string): string {
  if (address.length <= 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

/**
 * USD converted into the display currency. Returns null when the rate is missing rather than
 * falling back to the USD number — silently showing USD figures under a THB label would
 * misstate net worth by ~35x.
 */
export function convertFromUsd(usd: number, currency: Currency, rates: Rates | null): number | null {
  if (currency === 'usd') return usd
  if (!rates) return null
  if (currency === 'thb') return typeof rates.thb === 'number' ? usd * rates.thb : null
  if (currency === 'sats') {
    const btcUsd = rates.btc_usd
    if (typeof btcUsd !== 'number' || btcUsd <= 0) return null
    return (usd / btcUsd) * 100_000_000
  }
  return null
}

export function formatCurrency(usd: number, currency: Currency, rates: Rates | null): string {
  const converted = convertFromUsd(usd, currency, rates)
  if (converted === null) return '—'
  if (currency === 'usd') return formatUsd(converted)
  if (currency === 'thb') return `฿${converted.toLocaleString('en-US', { maximumFractionDigits: 0 })}`
  return `${converted.toLocaleString('en-US', { maximumFractionDigits: 0 })} sats`
}

/** "3h ago" / "2d ago" — for data freshness, where exact timestamps are noise. */
export function formatRelativeTime(epochSeconds: number): string {
  const deltaSec = Date.now() / 1000 - epochSeconds
  if (!Number.isFinite(deltaSec)) return '—'
  if (deltaSec < 60) return 'just now'
  const mins = Math.floor(deltaSec / 60)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** Duration in seconds → "5d 3h" / "3h 20m". Used for fee-cycle age and in-range time. */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—'
  const days = Math.floor(seconds / 86_400)
  const hours = Math.floor((seconds % 86_400) / 3_600)
  const mins = Math.floor((seconds % 3_600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}
