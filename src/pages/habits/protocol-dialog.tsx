import { useState, useEffect } from 'react'
import { Plus, Trash2, Sun, Moon, Brain, Dumbbell, Salad, Sparkles } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

export interface ProtocolStep {
  id: string
  label: string
  order: number
}

interface ProtocolDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title?: string
  defaultValues?: {
    title?: string
    description?: string
    steps?: ProtocolStep[]
  }
  onSubmit: (values: {
    title: string
    description: string
    steps: ProtocolStep[]
  }) => void
}

interface PresetTemplate {
  icon: typeof Sun
  label: string
  title: string
  description: string
  steps: string[]
}

const PRESETS: PresetTemplate[] = [
  {
    icon: Sun,
    label: 'Morning',
    title: 'Morning Protocol',
    description: 'Start the day with intention',
    steps: ['Wake up early', 'Drink water (500ml)', 'Meditate 10 min', 'Exercise 30 min', 'Shower', 'Journal / plan the day'],
  },
  {
    icon: Moon,
    label: 'Before Bed',
    title: 'Before Bed Protocol',
    description: 'Wind down for quality sleep',
    steps: ['No screens 30 min before bed', 'Prepare tomorrow\'s clothes', 'Read 20 min', 'Stretch / breathe', 'Gratitude journal (3 things)'],
  },
  {
    icon: Brain,
    label: 'Deep Work',
    title: 'Deep Work Protocol',
    description: 'Enter focused flow state',
    steps: ['Close all notifications', 'Set a clear goal for the session', 'Set timer (50 min)', 'Single-task only', 'Take a 10 min break', 'Review what you accomplished'],
  },
  {
    icon: Dumbbell,
    label: 'Workout',
    title: 'Workout Protocol',
    description: 'Complete workout routine',
    steps: ['Warm up 5 min', 'Main workout', 'Cool down / stretch', 'Log workout in Health', 'Drink protein shake'],
  },
  {
    icon: Salad,
    label: 'Nutrition',
    title: 'Daily Nutrition Protocol',
    description: 'Hit your nutrition targets',
    steps: ['Eat protein with every meal', 'Eat 5 servings of vegetables', 'Drink 2L water', 'Take supplements', 'No processed food'],
  },
  {
    icon: Sparkles,
    label: 'Weekly Review',
    title: 'Weekly Review Protocol',
    description: 'Reflect and plan ahead',
    steps: ['Review completed tasks', 'Review goals progress', 'Clear inbox to zero', 'Plan next week\'s priorities', 'Celebrate wins'],
  },
]

function makeSteps(labels: string[]): ProtocolStep[] {
  return labels.map((label, i) => ({ id: crypto.randomUUID(), label, order: i }))
}

export function ProtocolDialog({
  open,
  onOpenChange,
  title: dialogTitle = 'New Protocol',
  defaultValues,
  onSubmit,
}: ProtocolDialogProps) {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [steps, setSteps] = useState<ProtocolStep[]>([])
  const [newStep, setNewStep] = useState('')
  const [showForm, setShowForm] = useState(false)

  useEffect(() => {
    if (open) {
      setName(defaultValues?.title || '')
      setDescription(defaultValues?.description || '')
      setSteps(defaultValues?.steps || [])
      setNewStep('')
      // If editing, go straight to form; if creating, show presets first
      setShowForm(!!defaultValues)
    }
  }, [open, defaultValues])

  const applyPreset = (preset: PresetTemplate) => {
    setName(preset.title)
    setDescription(preset.description)
    setSteps(makeSteps(preset.steps))
    setShowForm(true)
  }

  const addStep = () => {
    if (!newStep.trim()) return
    setSteps((prev) => [
      ...prev,
      { id: crypto.randomUUID(), label: newStep.trim(), order: prev.length },
    ])
    setNewStep('')
  }

  const removeStep = (id: string) => {
    setSteps((prev) =>
      prev.filter((s) => s.id !== id).map((s, i) => ({ ...s, order: i })),
    )
  }

  const moveStep = (index: number, direction: -1 | 1) => {
    const newIndex = index + direction
    if (newIndex < 0 || newIndex >= steps.length) return
    const updated = [...steps]
    const [moved] = updated.splice(index, 1)
    updated.splice(newIndex, 0, moved)
    setSteps(updated.map((s, i) => ({ ...s, order: i })))
  }

  const updateStepLabel = (id: string, label: string) => {
    setSteps((prev) => prev.map((s) => (s.id === id ? { ...s, label } : s)))
  }

  const handleSubmit = () => {
    if (!name.trim() || steps.length === 0) return
    onSubmit({
      title: name.trim(),
      description: description.trim(),
      steps,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{dialogTitle}</DialogTitle>
          <DialogDescription>
            Define the steps that make up this habit.
          </DialogDescription>
        </DialogHeader>

        {/* Preset picker — shown when creating (not editing) */}
        {!showForm && !defaultValues && (
          <div className="space-y-3">
            <p className="text-xs text-muted-foreground">Start from a template or create from scratch.</p>
            <div className="grid grid-cols-2 gap-2">
              {PRESETS.map((preset) => {
                const Icon = preset.icon
                return (
                  <button
                    key={preset.label}
                    type="button"
                    className="flex items-center gap-2.5 p-3 rounded-lg border text-left hover:bg-accent/50 transition-colors"
                    onClick={() => applyPreset(preset)}
                  >
                    <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium truncate">{preset.label}</p>
                      <p className="text-[11px] text-muted-foreground truncate">{preset.steps.length} steps</p>
                    </div>
                  </button>
                )
              })}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => setShowForm(true)}
            >
              <Plus className="h-3.5 w-3.5 mr-1.5" /> Create from scratch
            </Button>
          </div>
        )}

        {/* Form — shown after picking preset or clicking "from scratch" */}
        {showForm && <div className="space-y-4">
          <div>
            <Label htmlFor="proto-name">Protocol Name</Label>
            <Input
              id="proto-name"
              placeholder="e.g. Morning Protocol"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>

          <div>
            <Label htmlFor="proto-desc">Description</Label>
            <Textarea
              id="proto-desc"
              placeholder="Optional"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>

          {/* Steps */}
          <div className="space-y-2">
            <Label>Steps</Label>

            {steps.length > 0 && (
              <div className="space-y-1.5">
                {steps.map((step, i) => (
                  <div key={step.id} className="flex items-center gap-1.5">
                    {/* Reorder buttons */}
                    <div className="flex flex-col shrink-0">
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground text-[10px] leading-none h-3 disabled:opacity-20"
                        onClick={() => moveStep(i, -1)}
                        disabled={i === 0}
                      >
                        ▲
                      </button>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground text-[10px] leading-none h-3 disabled:opacity-20"
                        onClick={() => moveStep(i, 1)}
                        disabled={i === steps.length - 1}
                      >
                        ▼
                      </button>
                    </div>

                    <span className="text-xs text-muted-foreground w-5 shrink-0 text-center">
                      {i + 1}
                    </span>

                    <Input
                      value={step.label}
                      onChange={(e) => updateStepLabel(step.id, e.target.value)}
                      className="h-8 text-sm flex-1"
                    />

                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-8 w-8 p-0 shrink-0"
                      onClick={() => removeStep(step.id)}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            {/* Add step input */}
            <div className="flex gap-1.5">
              <Input
                placeholder="Add a step..."
                value={newStep}
                onChange={(e) => setNewStep(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    addStep()
                  }
                }}
                className="h-8 text-sm"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 shrink-0"
                onClick={addStep}
                disabled={!newStep.trim()}
              >
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>

            {steps.length === 0 && (
              <p className="text-xs text-muted-foreground">Add at least one step.</p>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSubmit} disabled={!name.trim() || steps.length === 0}>
              {defaultValues ? 'Save' : 'Create'}
            </Button>
          </div>
        </div>}
      </DialogContent>
    </Dialog>
  )
}
