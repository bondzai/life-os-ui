/**
 * Health metric calculators.
 * All formulas use metric units (kg, cm).
 */

export type Gender = 'male' | 'female'

export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very-active'

export const ACTIVITY_LABELS: Record<ActivityLevel, string> = {
  sedentary: 'Sedentary (office job)',
  light: 'Light (1-3 days/week)',
  moderate: 'Moderate (3-5 days/week)',
  active: 'Active (6-7 days/week)',
  'very-active': 'Very Active (athlete)',
}

const ACTIVITY_MULTIPLIERS: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  'very-active': 1.9,
}

export interface HealthProfile {
  heightCm: number
  birthDate: string // YYYY-MM-DD
  gender: Gender
  activityLevel: ActivityLevel
}

export type BMICategory = 'underweight' | 'normal' | 'overweight' | 'obese'

const STORAGE_KEY = 'life-os:health-profile'

export function loadHealthProfile(): HealthProfile | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as HealthProfile
  } catch {
    return null
  }
}

export function saveHealthProfile(profile: HealthProfile): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(profile))
}

/** Calculate age from birth date */
export function calcAge(birthDate: string): number {
  const birth = new Date(birthDate)
  const now = new Date()
  let age = now.getFullYear() - birth.getFullYear()
  const monthDiff = now.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) {
    age--
  }
  return age
}

/** BMI = weight(kg) / height(m)² */
export function calcBMI(weightKg: number, heightCm: number): number {
  const heightM = heightCm / 100
  return weightKg / (heightM * heightM)
}

export function getBMICategory(bmi: number): BMICategory {
  if (bmi < 18.5) return 'underweight'
  if (bmi < 25) return 'normal'
  if (bmi < 30) return 'overweight'
  return 'obese'
}

export const BMI_COLORS: Record<BMICategory, string> = {
  underweight: 'text-blue-600 bg-blue-100 dark:bg-blue-900/40 dark:text-blue-400',
  normal: 'text-green-600 bg-green-100 dark:bg-green-900/40 dark:text-green-400',
  overweight: 'text-amber-600 bg-amber-100 dark:bg-amber-900/40 dark:text-amber-400',
  obese: 'text-red-600 bg-red-100 dark:bg-red-900/40 dark:text-red-400',
}

/**
 * BMR using Mifflin-St Jeor equation (most accurate for most people)
 * Male:   10 × weight(kg) + 6.25 × height(cm) − 5 × age − 161 + 166 → simplified to standard
 * Male:   10w + 6.25h − 5a + 5
 * Female: 10w + 6.25h − 5a − 161
 */
export function calcBMR(weightKg: number, heightCm: number, age: number, gender: Gender): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age
  return gender === 'male' ? base + 5 : base - 161
}

/** TDEE = BMR × activity multiplier */
export function calcTDEE(bmr: number, activityLevel: ActivityLevel): number {
  return bmr * ACTIVITY_MULTIPLIERS[activityLevel]
}

export type GoalMode = 'cut' | 'maintain' | 'lean-bulk' | 'bulk'

export interface TDEETargets {
  maintain: number
  cut: number        // -500 kcal (lose ~0.5kg/week)
  aggressiveCut: number // -750 kcal
  leanBulk: number   // +250 kcal (gain ~0.25kg/week)
  bulk: number       // +500 kcal (gain ~0.5kg/week)
}

/** Calculate calorie targets for bulk/cut based on TDEE */
export function calcTDEETargets(tdee: number): TDEETargets {
  return {
    maintain: Math.round(tdee),
    cut: Math.round(tdee - 500),
    aggressiveCut: Math.round(tdee - 750),
    leanBulk: Math.round(tdee + 250),
    bulk: Math.round(tdee + 500),
  }
}

/**
 * Suggest bulk or cut based on current BMI, weight trend, and body composition.
 * Returns a recommendation with reasoning.
 */
export function suggestGoalMode(
  bmi: number,
  bmiCategory: BMICategory,
  _weightTrend: { direction: 'up' | 'down' | 'stable'; change: number } | null,
  bodyFatPct?: number,
): { mode: GoalMode; reason: string } {
  let mode: GoalMode
  let reason: string

  // Use body fat % if available (more accurate than BMI)
  if (bodyFatPct !== undefined) {
    if (bodyFatPct > 25) {
      mode = 'cut'
      reason = `Body fat at ${bodyFatPct}% — cutting will improve body composition and health markers`
    } else if (bodyFatPct > 20) {
      mode = 'maintain'
      reason = `Body fat at ${bodyFatPct}% — good range, maintain or slight cut for definition`
    } else if (bodyFatPct > 12) {
      mode = 'lean-bulk'
      reason = `Body fat at ${bodyFatPct}% — great base for a lean bulk to add muscle`
    } else {
      mode = 'bulk'
      reason = `Body fat at ${bodyFatPct}% — very lean, bulk phase recommended to build mass`
    }
  } else {
    // Fall back to BMI-based suggestion
    switch (bmiCategory) {
      case 'obese':
        mode = 'cut'
        reason = 'BMI indicates excess weight — a calorie deficit will improve health outcomes'
        break
      case 'overweight':
        mode = 'cut'
        reason = 'Slightly above normal range — a moderate cut will bring you to a healthier weight'
        break
      case 'normal':
        if (bmi > 23) {
          mode = 'maintain'
          reason = 'Healthy weight — maintain current intake or slight cut for leanness'
        } else {
          mode = 'lean-bulk'
          reason = 'Healthy weight on the leaner side — a lean bulk can add muscle without excess fat'
        }
        break
      case 'underweight':
        mode = 'bulk'
        reason = 'Below healthy weight range — a calorie surplus will support weight and muscle gain'
        break
    }
  }

  return { mode, reason }
}

export function calcProtein(weightKg: number, mode: GoalMode): number {
  // g per kg bodyweight
  const multiplier = mode === 'cut' ? 2.0 : mode === 'maintain' ? 1.8 : 1.6
  return Math.round(weightKg * multiplier)
}

export const GOAL_MODE_LABELS: Record<GoalMode, string> = {
  cut: 'Cut',
  maintain: 'Maintain',
  'lean-bulk': 'Lean Bulk',
  bulk: 'Bulk',
}

export const GOAL_MODE_COLORS: Record<GoalMode, string> = {
  cut: 'text-red-600 bg-red-100 dark:bg-red-900/40 dark:text-red-400',
  maintain: 'text-blue-600 bg-blue-100 dark:bg-blue-900/40 dark:text-blue-400',
  'lean-bulk': 'text-green-600 bg-green-100 dark:bg-green-900/40 dark:text-green-400',
  bulk: 'text-purple-600 bg-purple-100 dark:bg-purple-900/40 dark:text-purple-400',
}

/** Ideal weight range based on BMI 18.5–24.9 */
export function calcIdealWeightRange(heightCm: number): { min: number; max: number } {
  const heightM = heightCm / 100
  return {
    min: Math.round(18.5 * heightM * heightM * 10) / 10,
    max: Math.round(24.9 * heightM * heightM * 10) / 10,
  }
}

/** 7-day moving average weight trend */
export function calcWeightTrend(
  entries: Array<{ value: number; date: string }>,
): { avg: number; direction: 'up' | 'down' | 'stable'; change: number } | null {
  if (entries.length < 2) return null

  const sorted = [...entries].sort((a, b) => b.date.localeCompare(a.date))
  const recent7 = sorted.slice(0, 7)
  const avg = recent7.reduce((sum, e) => sum + e.value, 0) / recent7.length

  // Compare current avg to previous period
  const prev7 = sorted.slice(7, 14)
  if (prev7.length === 0) {
    // Compare first and last in recent
    const change = recent7[0].value - recent7[recent7.length - 1].value
    return {
      avg: Math.round(avg * 10) / 10,
      direction: Math.abs(change) < 0.3 ? 'stable' : change > 0 ? 'up' : 'down',
      change: Math.round(change * 10) / 10,
    }
  }

  const prevAvg = prev7.reduce((sum, e) => sum + e.value, 0) / prev7.length
  const change = avg - prevAvg

  return {
    avg: Math.round(avg * 10) / 10,
    direction: Math.abs(change) < 0.3 ? 'stable' : change > 0 ? 'up' : 'down',
    change: Math.round(change * 10) / 10,
  }
}

/** Weekly active minutes and calories from workouts */
export function calcWeeklyActivity(
  workouts: Array<{ duration: number; calories?: number; date: string }>,
): { activeMinutes: number; caloriesBurned: number } {
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString().split('T')[0]

  let activeMinutes = 0
  let caloriesBurned = 0

  for (const w of workouts) {
    if (w.date >= weekAgo) {
      activeMinutes += w.duration || 0
      caloriesBurned += w.calories || 0
    }
  }

  return { activeMinutes, caloriesBurned }
}
