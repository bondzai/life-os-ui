const STORAGE_KEYS = [
  'life-os:entities',
  'life-os:trackers',
  'life-os:relations',
  'life-os:schedules',
  'life-os:users',
  'life-os:today-priorities',
  'life-os:last-review',
]

interface BackupData {
  version: 1
  exportedAt: string
  data: Record<string, unknown>
}

export function exportData(): void {
  const backup: BackupData = {
    version: 1,
    exportedAt: new Date().toISOString(),
    data: {},
  }

  for (const key of STORAGE_KEYS) {
    const raw = localStorage.getItem(key)
    if (raw) {
      try {
        backup.data[key] = JSON.parse(raw)
      } catch {
        backup.data[key] = raw
      }
    }
  }

  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `life-os-backup-${new Date().toISOString().split('T')[0]}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export async function importData(file: File): Promise<{ count: number }> {
  const text = await file.text()
  const backup: BackupData = JSON.parse(text)

  if (!backup.version || !backup.data) {
    throw new Error('Invalid backup file format')
  }

  let count = 0
  for (const [key, value] of Object.entries(backup.data)) {
    if (STORAGE_KEYS.includes(key)) {
      localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
      count++
    }
  }

  return { count }
}
