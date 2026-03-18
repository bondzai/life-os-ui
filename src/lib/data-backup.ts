/**
 * Data backup with versioned schema migrations.
 *
 * When you change the data schema, bump CURRENT_VERSION and add a migration
 * function to MIGRATIONS. Each migration transforms data from version N to N+1.
 *
 * Example: if you rename entity.priority → entity.urgency in v3:
 *
 *   const CURRENT_VERSION = 3
 *
 *   const MIGRATIONS: Record<number, MigrationFn> = {
 *     1: migrateV1toV2,
 *     2: (data) => {
 *       const entities = (data['lyra:entities'] ?? []) as Record<string, unknown>[]
 *       for (const e of entities) {
 *         e.urgency = e.priority
 *         delete e.priority
 *       }
 *       return data
 *     },
 *   }
 */

const CURRENT_VERSION = 2

const STORAGE_KEYS = [
  'lyra:entities',
  'lyra:trackers',
  'lyra:relations',
  'lyra:schedules',
  'lyra:users',
  'lyra:today-priorities',
  'lyra:last-review',
]

interface BackupData {
  version: number
  exportedAt: string
  data: Record<string, unknown>
}

// ── Migrations ────────────────────────────────────────────────────────
// Each function transforms data from version N to N+1.
// Key: the version being migrated FROM.

type MigrationFn = (data: Record<string, unknown>) => Record<string, unknown>

/**
 * v1 → v2: Migrate status enum values
 *   active → todo, completed → done, paused → in-progress
 */
function migrateV1toV2(data: Record<string, unknown>): Record<string, unknown> {
  const STATUS_MAP: Record<string, string> = {
    active: 'todo',
    completed: 'done',
    paused: 'in-progress',
  }

  const entities = (data['lyra:entities'] ?? []) as Record<string, unknown>[]
  for (const e of entities) {
    if (typeof e.status === 'string' && STATUS_MAP[e.status]) {
      e.status = STATUS_MAP[e.status]
    }
  }

  return data
}

const MIGRATIONS: Record<number, MigrationFn> = {
  1: migrateV1toV2,
}

// ── Core ──────────────────────────────────────────────────────────────

function applyMigrations(backup: BackupData): BackupData {
  let { version, data } = backup

  while (version < CURRENT_VERSION) {
    const migrate = MIGRATIONS[version]
    if (!migrate) {
      throw new Error(`No migration found for version ${version} → ${version + 1}`)
    }
    data = migrate(data)
    version++
  }

  return { ...backup, version, data }
}

export function exportData(): void {
  const backup: BackupData = {
    version: CURRENT_VERSION,
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
  a.download = `lyra-backup-${new Date().toISOString().split('T')[0]}.json`
  a.click()
  URL.revokeObjectURL(url)
}

export async function importData(file: File): Promise<{ count: number; migrated: boolean }> {
  const text = await file.text()
  const raw = JSON.parse(text) as BackupData

  if (!raw.data) {
    throw new Error('Invalid backup file format')
  }

  // Treat missing version as v1 (legacy backups)
  if (!raw.version) raw.version = 1

  if (raw.version > CURRENT_VERSION) {
    throw new Error(
      `Backup is from a newer version (v${raw.version}). Update the app first.`,
    )
  }

  const migrated = raw.version < CURRENT_VERSION
  const backup = migrated ? applyMigrations(raw) : raw

  let count = 0
  for (const [key, value] of Object.entries(backup.data)) {
    if (STORAGE_KEYS.includes(key)) {
      localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value))
      count++
    }
  }

  return { count, migrated }
}
