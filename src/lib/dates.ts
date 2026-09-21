/**
 * Dates and elapsed time, in one place.
 *
 * There were four copies of "how long ago was this" and three of "what is this day's key", and
 * they did not agree: one said `Yesterday`, another `yesterday`; two built the day key from local
 * calendar fields and the third from `toISOString()`.
 *
 * That last one was not a style difference. `toISOString()` is UTC, so a local midnight anywhere
 * east of Greenwich serialises as the *previous* day — in UTC+7 the week view keyed every column
 * one day behind the month view it sits next to, and events landed in the wrong cell.
 *
 * `formatRelativeTime` in `pages/wealth/format.ts` is deliberately not folded in here: it takes
 * epoch seconds and never degrades to a calendar date, because it labels data freshness rather
 * than an event, and "12 Sep" is not an answer to "how stale is this number".
 */

/** `2026-09-21` for a date, in the **local** calendar — never UTC. See the note above. */
export function dateKey(d: Date): string {
  return dateKeyOf(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Same key from the parts a calendar grid already has. `month` is 0-based, as `Date` has it. */
export function dateKeyOf(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** The default long form, once something is too old to be worth counting days for. */
function longForm(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * "just now" / "5m ago" / "3h ago" / "yesterday" / "4d ago" / a date.
 *
 * The week of `Nd ago` is the part the two copies disagreed about, and it is the useful part: on
 * a notification list "4d ago" places something that a locale date makes you subtract to read.
 */
export function relativeTime(iso: string, long: (iso: string) => string = longForm): string {
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return long(iso)
}
