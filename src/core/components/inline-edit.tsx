import { useState, useRef, useEffect } from 'react'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

interface InlineEditProps {
  value: string
  onSave: (newValue: string) => void
  multiline?: boolean
  placeholder?: string
  className?: string
}

export function InlineEdit({
  value,
  onSave,
  multiline = false,
  placeholder,
  className,
}: InlineEditProps) {
  const [isEditing, setIsEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null)

  useEffect(() => {
    if (isEditing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [isEditing])

  useEffect(() => {
    setDraft(value)
  }, [value])

  const save = () => {
    const trimmed = draft.trim()
    if (trimmed && trimmed !== value) {
      onSave(trimmed)
    } else {
      setDraft(value)
    }
    setIsEditing(false)
  }

  const cancel = () => {
    setDraft(value)
    setIsEditing(false)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !multiline) {
      e.preventDefault()
      save()
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      cancel()
    }
  }

  if (!isEditing) {
    return (
      <span
        className={cn(
          'cursor-pointer hover:bg-accent/50 rounded px-1 -mx-1 transition-colors',
          className,
        )}
        onClick={() => setIsEditing(true)}
      >
        {value || placeholder || 'Click to edit'}
      </span>
    )
  }

  if (multiline) {
    return (
      <Textarea
        ref={inputRef as React.Ref<HTMLTextAreaElement>}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        className={cn('text-sm', className)}
        rows={3}
      />
    )
  }

  return (
    <Input
      ref={inputRef as React.Ref<HTMLInputElement>}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={save}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      className={cn('text-sm h-auto py-1', className)}
    />
  )
}
