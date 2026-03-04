const KEY = 'life-os:today-priorities'

interface TodayPriorities {
  date: string
  ids: string[]
}

export function getTodayPriorities(): string[] {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) return []
    const data: TodayPriorities = JSON.parse(raw)
    const today = new Date().toISOString().split('T')[0]
    if (data.date !== today) return [] // expired
    return data.ids
  } catch {
    return []
  }
}

export function setTodayPriorities(ids: string[]): void {
  const today = new Date().toISOString().split('T')[0]
  localStorage.setItem(KEY, JSON.stringify({ date: today, ids }))
}
