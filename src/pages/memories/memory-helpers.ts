export const MOODS = ['joyful', 'peaceful', 'nostalgic', 'excited', 'grateful', 'bittersweet'] as const
export type MemoryMood = (typeof MOODS)[number]

export const MOOD_EMOJI: Record<MemoryMood, string> = {
  joyful: '😄',
  peaceful: '😌',
  nostalgic: '🥹',
  excited: '🤩',
  grateful: '🙏',
  bittersweet: '🥲',
}

export const MOOD_COLORS: Record<MemoryMood, string> = {
  joyful: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-300',
  peaceful: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-300',
  nostalgic: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-300',
  excited: 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-300',
  grateful: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-300',
  bittersweet: 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-300',
}

export const STORAGE_BUDGET_BYTES = 3.5 * 1024 * 1024 // 3.5MB
