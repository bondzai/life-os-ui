export const BODY_METRIC_TYPES = ['weight', 'body-fat', 'waist', 'chest', 'arms', 'bmi'] as const
export type BodyMetricType = (typeof BODY_METRIC_TYPES)[number]

export const WORKOUT_TYPES = ['strength', 'cardio', 'flexibility', 'hiit', 'sports', 'other'] as const
export type WorkoutType = (typeof WORKOUT_TYPES)[number]

export const MOOD_OPTIONS = ['great', 'good', 'okay', 'bad', 'terrible'] as const
export type MoodLevel = (typeof MOOD_OPTIONS)[number]

export const SLEEP_QUALITY = ['deep', 'good', 'light', 'poor', 'insomnia'] as const
export type SleepQuality = (typeof SLEEP_QUALITY)[number]

export const METRIC_UNITS: Record<BodyMetricType, string> = {
  weight: 'kg',
  'body-fat': '%',
  waist: 'cm',
  chest: 'cm',
  arms: 'cm',
  bmi: '',
}

export const MOOD_COLORS: Record<MoodLevel, string> = {
  great: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  good: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  okay: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  bad: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  terrible: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
}

export const SLEEP_COLORS: Record<SleepQuality, string> = {
  deep: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200',
  good: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  light: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200',
  poor: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  insomnia: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
}

export const WORKOUT_COLORS: Record<WorkoutType, string> = {
  strength: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
  cardio: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  flexibility: 'bg-teal-100 text-teal-800 dark:bg-teal-900 dark:text-teal-200',
  hiit: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200',
  sports: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  other: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-200',
}
