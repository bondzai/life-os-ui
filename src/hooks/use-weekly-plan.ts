import { useState, useCallback, useMemo } from 'react'

// ─── Types ───

export interface WeeklyOutcome {
  id: string
  text: string
  linkedEntityIds: string[]
  status: 'open' | 'done' | 'missed'
}

export interface DayAllocation {
  date: string // YYYY-MM-DD
  entityIds: string[]
}

export interface WeeklyPlan {
  weekOf: string // Monday ISO date
  outcomes: WeeklyOutcome[]
  allocations: DayAllocation[]
  locked: boolean
  createdAt: string
}

// ─── Helpers ───

const STORAGE_KEY = 'lyra:weekly-plan'

function getMonday(d: Date = new Date()): string {
  const date = new Date(d)
  const day = date.getDay()
  date.setDate(date.getDate() - (day === 0 ? 6 : day - 1))
  return date.toISOString().split('T')[0]
}

function getWeekDates(monday: string): string[] {
  const dates: string[] = []
  const d = new Date(monday + 'T00:00:00')
  for (let i = 0; i < 7; i++) {
    const dd = new Date(d)
    dd.setDate(dd.getDate() + i)
    dates.push(dd.toISOString().split('T')[0])
  }
  return dates
}

function loadPlan(): WeeklyPlan | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function savePlan(plan: WeeklyPlan) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(plan))
}

// ─── Hook ───

export function useWeeklyPlan() {
  const currentMonday = useMemo(() => getMonday(), [])
  const weekDates = useMemo(() => getWeekDates(currentMonday), [currentMonday])

  const [plan, setPlanState] = useState<WeeklyPlan | null>(() => {
    const saved = loadPlan()
    // Only return if it's for the current week
    if (saved && saved.weekOf === currentMonday) return saved
    return null
  })

  const persist = useCallback((p: WeeklyPlan) => {
    setPlanState(p)
    savePlan(p)
  }, [])

  const createPlan = useCallback(() => {
    const p: WeeklyPlan = {
      weekOf: currentMonday,
      outcomes: [],
      allocations: weekDates.map((date) => ({ date, entityIds: [] })),
      locked: false,
      createdAt: new Date().toISOString(),
    }
    persist(p)
    return p
  }, [currentMonday, weekDates, persist])

  const setOutcomes = useCallback((outcomes: WeeklyOutcome[]) => {
    const p = plan ?? createPlan()
    persist({ ...p, outcomes: outcomes.slice(0, 3) })
  }, [plan, createPlan, persist])

  const updateOutcomeStatus = useCallback((id: string, status: WeeklyOutcome['status']) => {
    if (!plan) return
    persist({
      ...plan,
      outcomes: plan.outcomes.map((o) => o.id === id ? { ...o, status } : o),
    })
  }, [plan, persist])

  const allocateTask = useCallback((date: string, entityId: string) => {
    if (!plan || plan.locked) return
    // Remove from any other day first
    const allocations = plan.allocations.map((a) => ({
      ...a,
      entityIds: a.entityIds.filter((id) => id !== entityId),
    }))
    // Add to target day
    const dayIdx = allocations.findIndex((a) => a.date === date)
    if (dayIdx >= 0) {
      allocations[dayIdx] = {
        ...allocations[dayIdx],
        entityIds: [...allocations[dayIdx].entityIds, entityId],
      }
    }
    persist({ ...plan, allocations })
  }, [plan, persist])

  const unallocateTask = useCallback((entityId: string) => {
    if (!plan || plan.locked) return
    persist({
      ...plan,
      allocations: plan.allocations.map((a) => ({
        ...a,
        entityIds: a.entityIds.filter((id) => id !== entityId),
      })),
    })
  }, [plan, persist])

  const lockPlan = useCallback(() => {
    if (!plan) return
    persist({ ...plan, locked: true })
  }, [plan, persist])

  const unlockPlan = useCallback(() => {
    if (!plan) return
    persist({ ...plan, locked: false })
  }, [plan, persist])

  // Get allocations for a specific date
  const getAllocationsForDate = useCallback((date: string): string[] => {
    if (!plan) return []
    return plan.allocations.find((a) => a.date === date)?.entityIds ?? []
  }, [plan])

  // All allocated entity IDs (flat)
  const allocatedIds = useMemo(() => {
    if (!plan) return new Set<string>()
    return new Set(plan.allocations.flatMap((a) => a.entityIds))
  }, [plan])

  const today = new Date().toISOString().split('T')[0]
  const todayAllocations = getAllocationsForDate(today)

  return {
    plan,
    currentMonday,
    weekDates,
    todayAllocations,
    allocatedIds,
    createPlan,
    setOutcomes,
    updateOutcomeStatus,
    allocateTask,
    unallocateTask,
    getAllocationsForDate,
    lockPlan,
    unlockPlan,
  }
}
