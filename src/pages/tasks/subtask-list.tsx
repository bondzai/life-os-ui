import { useState } from 'react'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Checkbox } from '@/components/ui/checkbox'

interface Subtask {
  id: string
  title: string
  done: boolean
}

interface SubtaskListProps {
  subtasks: Subtask[]
  onChange: (subtasks: Subtask[]) => void
}

export function SubtaskList({ subtasks, onChange }: SubtaskListProps) {
  const [newTitle, setNewTitle] = useState('')

  const addSubtask = () => {
    if (!newTitle.trim()) return
    onChange([...subtasks, { id: crypto.randomUUID(), title: newTitle.trim(), done: false }])
    setNewTitle('')
  }

  const toggleSubtask = (id: string) => {
    onChange(subtasks.map((s) => (s.id === id ? { ...s, done: !s.done } : s)))
  }

  const removeSubtask = (id: string) => {
    onChange(subtasks.filter((s) => s.id !== id))
  }

  return (
    <div className="space-y-1.5">
      {subtasks.map((st) => (
        <div key={st.id} className="flex items-center gap-2">
          <Checkbox checked={st.done} onCheckedChange={() => toggleSubtask(st.id)} />
          <span className={`text-xs flex-1 ${st.done ? 'line-through text-muted-foreground' : ''}`}>
            {st.title}
          </span>
          <Button variant="ghost" size="sm" className="h-5 w-5 p-0" onClick={() => removeSubtask(st.id)}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      ))}
      <div className="flex gap-1">
        <Input
          placeholder="Add subtask..."
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addSubtask())}
          className="h-7 text-xs"
        />
        <Button variant="ghost" size="sm" className="h-7 px-2" onClick={addSubtask}>
          <Plus className="h-3 w-3" />
        </Button>
      </div>
    </div>
  )
}
