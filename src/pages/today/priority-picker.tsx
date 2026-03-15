import { useState } from 'react'
import { Star, Plus, ListChecks } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import type { Entity } from '@/core/types'

interface PriorityPickerProps {
  candidates: Entity[]
  existingIds?: string[]
  onSave: (ids: string[]) => void
  onCreate?: (title: string, subtasks: string[]) => void
}

export function PriorityPicker({ candidates, existingIds = [], onSave, onCreate }: PriorityPickerProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set(existingIds))
  const [mode, setMode] = useState<'pick' | 'create'>('pick')
  const [newTitle, setNewTitle] = useState('')
  const [newSteps, setNewSteps] = useState<string[]>([])
  const [stepInput, setStepInput] = useState('')

  const maxItems = 3

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else if (next.size < maxItems) {
        next.add(id)
      }
      return next
    })
  }

  const addStep = () => {
    if (!stepInput.trim()) return
    setNewSteps((prev) => [...prev, stepInput.trim()])
    setStepInput('')
  }

  const handleCreate = () => {
    if (!newTitle.trim() || !onCreate) return
    onCreate(newTitle.trim(), newSteps)
    setNewTitle('')
    setNewSteps([])
    setMode('pick')
  }

  // Create story form
  if (mode === 'create') {
    return (
      <Card className="border-dashed border-primary/30">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium">
            <ListChecks className="h-4 w-4 text-primary" />
            Create a story
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            placeholder="Story title (e.g. Fix auth module)"
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            autoFocus
          />

          {/* Steps */}
          {newSteps.length > 0 && (
            <div className="space-y-1 pl-1">
              {newSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-2 text-sm">
                  <span className="text-muted-foreground/40 text-xs w-4 text-center">{i + 1}</span>
                  <span>{step}</span>
                  <button
                    className="text-muted-foreground/30 hover:text-destructive text-xs ml-auto"
                    onClick={() => setNewSteps((prev) => prev.filter((_, j) => j !== i))}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-1.5">
            <Input
              placeholder="Add a step..."
              value={stepInput}
              onChange={(e) => setStepInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); addStep() }
              }}
              className="text-sm h-8"
            />
            <Button variant="outline" size="sm" className="h-8 shrink-0" onClick={addStep} disabled={!stepInput.trim()}>
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </div>

          <p className="text-[11px] text-muted-foreground/50">
            {newSteps.length === 0
              ? 'Add steps to break your story into actionable chunks, or leave empty for a simple task.'
              : `${newSteps.length} step${newSteps.length > 1 ? 's' : ''}`
            }
          </p>

          <div className="flex gap-2">
            <Button size="sm" onClick={handleCreate} disabled={!newTitle.trim()}>
              Create & Focus
            </Button>
            <Button size="sm" variant="outline" onClick={() => setMode('pick')}>
              Back
            </Button>
          </div>
        </CardContent>
      </Card>
    )
  }

  // Pick from existing tasks
  return (
    <Card className="border-dashed border-primary/30">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Star className="h-4 w-4 text-yellow-500" />
          {existingIds.length > 0 ? 'Add to today\'s focus' : 'Pick your focus for today'}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="space-y-1.5 max-h-48 overflow-y-auto">
          {candidates.length === 0 ? (
            <p className="text-sm text-muted-foreground">No active tasks or goals.</p>
          ) : (
            candidates
              .filter((item) => !existingIds.includes(item.id))
              .map((item) => {
                const hasSubs = Array.isArray(item.metadata.subtasks) && (item.metadata.subtasks as unknown[]).length > 0
                return (
                  <div key={item.id} className="flex items-center gap-2 py-0.5">
                    <Checkbox
                      checked={selected.has(item.id)}
                      onCheckedChange={() => toggle(item.id)}
                      disabled={!selected.has(item.id) && selected.size >= maxItems}
                    />
                    <span className="text-sm truncate flex-1">{item.title}</span>
                    {hasSubs && <ListChecks className="h-3 w-3 text-muted-foreground/40 shrink-0" />}
                    <span className="text-[10px] text-muted-foreground/40 capitalize shrink-0">{item.type}</span>
                  </div>
                )
              })
          )}
        </div>

        <div className="flex gap-2 flex-wrap">
          {(candidates.length > 0 || existingIds.length > 0) && (
            <Button
              size="sm"
              disabled={selected.size === 0}
              onClick={() => onSave(Array.from(selected))}
            >
              {existingIds.length > 0 ? 'Add' : 'Set focus'} ({selected.size - existingIds.length})
            </Button>
          )}
          {onCreate && (
            <Button size="sm" variant="outline" onClick={() => setMode('create')}>
              <Plus className="h-3.5 w-3.5 mr-1" />
              New story
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
