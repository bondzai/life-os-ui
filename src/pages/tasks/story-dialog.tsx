import { useState, useEffect } from 'react'
import { Plus, Trash2, ListChecks } from 'lucide-react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

interface Subtask {
  id: string
  title: string
  done: boolean
}

interface StoryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  workspace?: 'work' | 'personal'
  defaultSubtasks?: Subtask[]
  onSubmit: (values: {
    title: string
    description: string
    priority: string
    dueDate: string
    workspace: string
    subtasks: Subtask[]
  }) => void
}

export function StoryDialog({ open, onOpenChange, workspace, defaultSubtasks, onSubmit }: StoryDialogProps) {
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [priority, setPriority] = useState('high')
  const [dueDate, setDueDate] = useState('')
  const [ws, setWs] = useState<string>(workspace || '')
  const [subtasks, setSubtasks] = useState<Subtask[]>([])
  const [stepInput, setStepInput] = useState('')

  useEffect(() => {
    if (open) {
      setTitle('')
      setDescription('')
      setPriority('high')
      setDueDate(new Date().toISOString().split('T')[0])
      setWs(workspace || '')
      setSubtasks(defaultSubtasks || [])
      setStepInput('')
    }
  }, [open, workspace])

  const addStep = () => {
    if (!stepInput.trim()) return
    setSubtasks((prev) => [...prev, { id: crypto.randomUUID(), title: stepInput.trim(), done: false }])
    setStepInput('')
  }

  const removeStep = (id: string) => {
    setSubtasks((prev) => prev.filter((s) => s.id !== id))
  }

  const moveStep = (index: number, dir: -1 | 1) => {
    const newIndex = index + dir
    if (newIndex < 0 || newIndex >= subtasks.length) return
    const updated = [...subtasks]
    const [moved] = updated.splice(index, 1)
    updated.splice(newIndex, 0, moved)
    setSubtasks(updated)
  }

  const handleSubmit = () => {
    if (!title.trim() || subtasks.length === 0) return
    onSubmit({
      title: title.trim(),
      description: description.trim(),
      priority,
      dueDate,
      workspace: ws,
      subtasks,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ListChecks className="h-4 w-4" />
            New Story
          </DialogTitle>
          <DialogDescription>
            A story is a task broken into steps. Work through them one by one.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label htmlFor="story-title">Title</Label>
            <Input
              id="story-title"
              placeholder="e.g. Implement user authentication"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              autoFocus
            />
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label>Priority</Label>
              <Select value={priority} onValueChange={setPriority}>
                <SelectTrigger className="h-8 text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="urgent">Urgent</SelectItem>
                  <SelectItem value="high">High</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="low">Low</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Due Date</Label>
              <Input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} className="h-8 text-sm" />
            </div>
            <div>
              <Label>Workspace</Label>
              <Select value={ws} onValueChange={setWs}>
                <SelectTrigger className="h-8 text-sm"><SelectValue placeholder="None" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="work">🏢 Work</SelectItem>
                  <SelectItem value="personal">🏠 Personal</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div>
            <Label htmlFor="story-desc">Description</Label>
            <Textarea
              id="story-desc"
              placeholder="Optional"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
            />
          </div>

          {/* Steps */}
          <div className="space-y-2">
            <Label>Steps ({subtasks.length})</Label>

            {subtasks.length > 0 && (
              <div className="space-y-1">
                {subtasks.map((step, i) => (
                  <div key={step.id} className="flex items-center gap-1.5">
                    <div className="flex flex-col shrink-0">
                      <button type="button" className="text-muted-foreground hover:text-foreground text-[10px] leading-none h-3 disabled:opacity-20"
                        onClick={() => moveStep(i, -1)} disabled={i === 0}>▲</button>
                      <button type="button" className="text-muted-foreground hover:text-foreground text-[10px] leading-none h-3 disabled:opacity-20"
                        onClick={() => moveStep(i, 1)} disabled={i === subtasks.length - 1}>▼</button>
                    </div>
                    <span className="text-xs text-muted-foreground w-4 text-center shrink-0">{i + 1}</span>
                    <Input value={step.title} onChange={(e) => {
                      setSubtasks((prev) => prev.map((s) => s.id === step.id ? { ...s, title: e.target.value } : s))
                    }} className="h-7 text-sm flex-1" />
                    <Button type="button" variant="ghost" size="sm" className="h-7 w-7 p-0 shrink-0"
                      onClick={() => removeStep(step.id)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="flex gap-1.5">
              <Input
                placeholder="Add a step..."
                value={stepInput}
                onChange={(e) => setStepInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addStep() } }}
                className="h-8 text-sm"
              />
              <Button type="button" variant="outline" size="sm" className="h-8 shrink-0"
                onClick={addStep} disabled={!stepInput.trim()}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>

            {subtasks.length === 0 && (
              <p className="text-[11px] text-muted-foreground">Add at least one step to create a story.</p>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSubmit} disabled={!title.trim() || subtasks.length === 0}>
              Create Story
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
