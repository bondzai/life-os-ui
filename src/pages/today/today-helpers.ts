const PRIORITIES_KEY = 'lyra:today-priorities'
const PROTOCOL_KEY = 'lyra:daily-protocol'

interface TodayPriorities {
  date: string
  ids: string[]
}

export function getTodayPriorities(): string[] {
  try {
    const raw = localStorage.getItem(PRIORITIES_KEY)
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
  localStorage.setItem(PRIORITIES_KEY, JSON.stringify({ date: today, ids }))
}

/* ─── Daily Protocol ─── */

interface ProtocolState {
  date: string
  morning: boolean
  evening: boolean
}

export function getProtocolState(): ProtocolState {
  try {
    const raw = localStorage.getItem(PROTOCOL_KEY)
    if (!raw) return { date: '', morning: false, evening: false }
    const data: ProtocolState = JSON.parse(raw)
    const today = new Date().toISOString().split('T')[0]
    if (data.date !== today) return { date: today, morning: false, evening: false }
    return data
  } catch {
    return { date: '', morning: false, evening: false }
  }
}

export function setProtocolDone(phase: 'morning' | 'evening'): void {
  const today = new Date().toISOString().split('T')[0]
  const current = getProtocolState()
  const updated: ProtocolState = { ...current, date: today, [phase]: true }
  localStorage.setItem(PROTOCOL_KEY, JSON.stringify(updated))
}

/* ─── Focus Score ─── */

export interface ClarityMetrics {
  focusScore: number      // completed priorities / set priorities (0–100)
  noiseRatio: number      // inbox items / (inbox + archived today)
  knowledgeGrowth: number // knowledge notes created this week
}
