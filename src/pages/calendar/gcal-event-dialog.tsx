import { useState, useEffect, useRef } from 'react'
import { Loader2, Clock, MapPin, AlignLeft } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'

interface GCalEventDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultDate?: string
  onSubmit: (event: {
    summary: string
    description?: string
    location?: string
    start: { dateTime: string; timeZone: string }
    end: { dateTime: string; timeZone: string }
  }) => Promise<void>
}

function getDefaultTimes(dateStr?: string): { start: string; end: string } {
  const now = new Date()
  if (dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number)
    now.setFullYear(y, m - 1, d)
  }
  now.setMinutes(0, 0, 0)
  now.setHours(now.getHours() + 1)

  const end = new Date(now)
  end.setHours(end.getHours() + 1)

  const fmt = (d: Date) => {
    const y = d.getFullYear()
    const mo = String(d.getMonth() + 1).padStart(2, '0')
    const da = String(d.getDate()).padStart(2, '0')
    const h = String(d.getHours()).padStart(2, '0')
    const mi = String(d.getMinutes()).padStart(2, '0')
    return `${y}-${mo}-${da}T${h}:${mi}`
  }

  return { start: fmt(now), end: fmt(end) }
}

export function GCalEventDialog({ open, onOpenChange, defaultDate, onSubmit }: GCalEventDialogProps) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const titleRef = useRef<HTMLInputElement>(null)

  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [location, setLocation] = useState('')
  const [startDt, setStartDt] = useState('')
  const [endDt, setEndDt] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      const d = getDefaultTimes(defaultDate)
      setTitle('')
      setDescription('')
      setLocation('')
      setStartDt(d.start)
      setEndDt(d.end)
      setError(null)
      setTimeout(() => titleRef.current?.focus(), 100)
    }
  }, [open, defaultDate])

  const handleSubmit = async () => {
    if (!title.trim()) return
    setSaving(true)
    setError(null)
    try {
      await onSubmit({
        summary: title.trim(),
        description: description.trim() || undefined,
        location: location.trim() || undefined,
        start: { dateTime: new Date(startDt).toISOString(), timeZone: tz },
        end: { dateTime: new Date(endDt).toISOString(), timeZone: tz },
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create event')
      setSaving(false)
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="rounded-t-2xl" showCloseButton={false}>
        {/* Drag handle */}
        <div className="flex justify-center pt-2 pb-1">
          <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
        </div>

        <SheetHeader className="px-5 pb-2">
          <div className="flex items-center justify-between">
            <SheetTitle className="text-base">New Event</SheetTitle>
            <SheetDescription className="sr-only">Create a new Google Calendar event</SheetDescription>
            <Button
              size="sm"
              className="h-8 px-4 rounded-full bg-[#1a73e8] hover:bg-[#1557b0] text-white"
              onClick={handleSubmit}
              disabled={!title.trim() || saving}
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Save'}
            </Button>
          </div>
        </SheetHeader>

        <div className="px-5 pb-6 space-y-3">
          {/* Title — large, borderless, Google-style */}
          <Input
            ref={titleRef}
            placeholder="Add title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="border-0 text-lg font-normal px-0 h-11 focus-visible:ring-0 placeholder:text-muted-foreground/40"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && title.trim()) handleSubmit()
            }}
          />

          {/* Time row */}
          <div className="flex items-center gap-3 py-2">
            <Clock className="w-5 h-5 text-muted-foreground shrink-0" />
            <div className="flex-1 flex items-center gap-2 text-sm">
              <input
                type="datetime-local"
                value={startDt}
                onChange={(e) => {
                  setStartDt(e.target.value)
                  // Auto-adjust end to 1 hour after start
                  const s = new Date(e.target.value)
                  s.setHours(s.getHours() + 1)
                  const fmt = (d: Date) => {
                    const y = d.getFullYear()
                    const mo = String(d.getMonth() + 1).padStart(2, '0')
                    const da = String(d.getDate()).padStart(2, '0')
                    const h = String(d.getHours()).padStart(2, '0')
                    const mi = String(d.getMinutes()).padStart(2, '0')
                    return `${y}-${mo}-${da}T${h}:${mi}`
                  }
                  setEndDt(fmt(s))
                }}
                className="bg-transparent text-sm border-0 p-0 focus:outline-none [color-scheme:light] dark:[color-scheme:dark] w-auto"
              />
              <span className="text-muted-foreground">–</span>
              <input
                type="datetime-local"
                value={endDt}
                onChange={(e) => setEndDt(e.target.value)}
                className="bg-transparent text-sm border-0 p-0 focus:outline-none [color-scheme:light] dark:[color-scheme:dark] w-auto"
              />
            </div>
          </div>

          {/* Location row */}
          <div className="flex items-center gap-3">
            <MapPin className="w-5 h-5 text-muted-foreground shrink-0" />
            <Input
              placeholder="Add location"
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              className="border-0 h-9 px-0 focus-visible:ring-0 placeholder:text-muted-foreground/40"
            />
          </div>

          {/* Description row */}
          <div className="flex items-start gap-3">
            <AlignLeft className="w-5 h-5 text-muted-foreground shrink-0 mt-2" />
            <Textarea
              placeholder="Add description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="border-0 px-0 focus-visible:ring-0 placeholder:text-muted-foreground/40 resize-none min-h-[60px]"
              rows={2}
            />
          </div>

          {error && (
            <p className="text-xs text-destructive ml-8">{error}</p>
          )}
        </div>
      </SheetContent>
    </Sheet>
  )
}
