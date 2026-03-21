import { LayoutGrid, List } from 'lucide-react'

export type ViewMode = 'grid' | 'list'

const STORAGE_PREFIX = 'lyra:view-'

export function getStoredView(key: string): ViewMode {
  try {
    return (localStorage.getItem(STORAGE_PREFIX + key) as ViewMode) ?? 'grid'
  } catch {
    return 'grid'
  }
}

export function storeView(key: string, mode: ViewMode) {
  try {
    localStorage.setItem(STORAGE_PREFIX + key, mode)
  } catch {
    /* noop */
  }
}

export function ViewToggle({
  value,
  onChange,
}: {
  value: ViewMode
  onChange: (mode: ViewMode) => void
}) {
  return (
    <div className="inline-flex items-center rounded-lg bg-muted p-0.5">
      <button
        type="button"
        onClick={() => onChange('grid')}
        className={`inline-flex items-center justify-center rounded-md px-2 py-1 transition-colors ${
          value === 'grid'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <LayoutGrid className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={() => onChange('list')}
        className={`inline-flex items-center justify-center rounded-md px-2 py-1 transition-colors ${
          value === 'list'
            ? 'bg-background text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'
        }`}
      >
        <List className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
