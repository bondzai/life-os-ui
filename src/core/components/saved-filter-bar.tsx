import { useState } from 'react'
import { Save, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { useFilterStore, type SavedFilter } from '@/stores/filter-store'

interface SavedFilterBarProps {
  moduleKey: string
  currentCriteria: Record<string, string>
  onApply: (criteria: Record<string, string>) => void
}

export function SavedFilterBar({ moduleKey, currentCriteria, onApply }: SavedFilterBarProps) {
  const { saved, active, saveFilter, removeFilter, setActive } = useFilterStore()
  const [naming, setNaming] = useState(false)
  const [filterName, setFilterName] = useState('')

  const filters = saved[moduleKey] ?? []
  const activeId = active[moduleKey] ?? null

  const hasNonDefaultCriteria = Object.values(currentCriteria).some((v) => v !== 'all' && v !== '')

  const handleSave = () => {
    const name = filterName.trim()
    if (!name) return
    const filter: SavedFilter = {
      id: crypto.randomUUID(),
      name,
      criteria: { ...currentCriteria },
    }
    saveFilter(moduleKey, filter)
    setActive(moduleKey, filter.id)
    setFilterName('')
    setNaming(false)
  }

  const handleApply = (filter: SavedFilter) => {
    if (activeId === filter.id) {
      // Deselect
      setActive(moduleKey, null)
      const reset: Record<string, string> = {}
      for (const key of Object.keys(filter.criteria)) reset[key] = 'all'
      onApply(reset)
    } else {
      setActive(moduleKey, filter.id)
      onApply(filter.criteria)
    }
  }

  if (filters.length === 0 && !hasNonDefaultCriteria) return null

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {filters.map((f) => (
        <Badge
          key={f.id}
          variant={activeId === f.id ? 'default' : 'outline'}
          className="cursor-pointer gap-1 pr-1"
          onClick={() => handleApply(f)}
        >
          {f.name}
          <button
            className="ml-0.5 hover:text-destructive"
            onClick={(e) => {
              e.stopPropagation()
              removeFilter(moduleKey, f.id)
            }}
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}

      {hasNonDefaultCriteria && !naming && (
        <Button size="sm" variant="ghost" className="h-6 text-xs gap-1" onClick={() => setNaming(true)}>
          <Save className="h-3 w-3" /> Save filter
        </Button>
      )}

      {naming && (
        <div className="flex items-center gap-1">
          <Input
            value={filterName}
            onChange={(e) => setFilterName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSave()
              if (e.key === 'Escape') setNaming(false)
            }}
            placeholder="Filter name"
            className="h-6 w-28 text-xs"
            autoFocus
          />
          <Button size="sm" variant="ghost" className="h-6 px-1" onClick={handleSave}>
            <Save className="h-3 w-3" />
          </Button>
          <Button size="sm" variant="ghost" className="h-6 px-1" onClick={() => setNaming(false)}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  )
}
