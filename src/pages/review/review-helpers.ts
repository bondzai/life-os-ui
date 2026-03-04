const KEY = 'life-os:last-review'

export function getLastReviewDate(): string | null {
  return localStorage.getItem(KEY)
}

export function setLastReviewDate(): void {
  localStorage.setItem(KEY, new Date().toISOString().split('T')[0])
}

export function getWeekStart(): string {
  const d = new Date()
  d.setDate(d.getDate() - d.getDay()) // Sunday
  d.setHours(0, 0, 0, 0)
  return d.toISOString().split('T')[0]
}

export function isReviewDoneThisWeek(): boolean {
  const last = getLastReviewDate()
  if (!last) return false
  return last >= getWeekStart()
}

export function daysAgo(dateStr: string): number {
  const now = new Date()
  const d = new Date(dateStr)
  return Math.floor((now.getTime() - d.getTime()) / 86400000)
}
