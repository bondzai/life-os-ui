const STORAGE_KEY = 'life-os:automation-runs'

export interface AutomationRun {
  id: string
  automationId: string
  automationTitle: string
  timestamp: string
  result: 'success' | 'error'
  details?: string
}

export function getRuns(): AutomationRun[] {
  const raw = localStorage.getItem(STORAGE_KEY)
  return raw ? (JSON.parse(raw) as AutomationRun[]) : []
}

export function addRun(run: AutomationRun): void {
  const runs = getRuns()
  runs.unshift(run)
  // Keep last 200 entries
  if (runs.length > 200) runs.length = 200
  localStorage.setItem(STORAGE_KEY, JSON.stringify(runs))
}

export function clearRuns(): void {
  localStorage.removeItem(STORAGE_KEY)
}
