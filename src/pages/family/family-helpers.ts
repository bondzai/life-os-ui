export const CHORE_FREQUENCIES = ['daily', 'weekly', 'biweekly', 'monthly'] as const
export type ChoreFrequency = (typeof CHORE_FREQUENCIES)[number]

export const CHORE_CATEGORIES = ['cleaning', 'cooking', 'laundry', 'shopping', 'maintenance', 'pets', 'other'] as const
export type ChoreCategory = (typeof CHORE_CATEGORIES)[number]

export const ASSIGNEES = [
  { id: 'user-jb', name: 'JB' },
  { id: 'user-sunny', name: 'Sunny' },
] as const

export const FREQUENCY_LABELS: Record<ChoreFrequency, string> = {
  daily: 'Daily',
  weekly: 'Weekly',
  biweekly: 'Bi-weekly',
  monthly: 'Monthly',
}

export const CATEGORY_COLORS: Record<ChoreCategory, string> = {
  cleaning: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  cooking: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
  laundry: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
  shopping: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  maintenance: 'bg-gray-100 text-gray-800 dark:bg-gray-900 dark:text-gray-300',
  pets: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
  other: 'bg-slate-100 text-slate-800 dark:bg-slate-900 dark:text-slate-300',
}

export const ENTITY_TYPE_LABELS: Record<string, string> = {
  goal: 'Goal',
  task: 'Task',
  habit: 'Habit',
  event: 'Event',
  note: 'Note',
  post: 'Post',
  chore: 'Chore',
  transaction: 'Transaction',
  budget: 'Budget',
  place: 'Place',
  trip: 'Trip',
  device: 'Device',
  service: 'Service',
  workout: 'Workout',
  'body-metric': 'Body Metric',
  'sleep-mood': 'Sleep & Mood',
  asset: 'Asset',
  wallet: 'Wallet',
  'crypto-tx': 'Crypto Tx',
  account: 'Account',
  book: 'Book',
  course: 'Course',
  skill: 'Skill',
}
