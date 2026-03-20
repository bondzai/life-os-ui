import { useState } from 'react'
import { MapPin, Clock, Calendar, Tag, Flag, Pencil, Trash2, Loader2 } from 'lucide-react'
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import type { Entity } from '@/core/types'
import type { ICalEvent } from '@/lib/ical'

const GCAL_COLORS: Record<string, string> = {
  task: '#039BE5',
  goal: '#33B679',
  event: '#7986CB',
  habit: '#F4511E',
  chore: '#616161',
}

interface EventDetailSheetProps {
  event: Entity | ICalEvent | null
  open: boolean
  onOpenChange: (open: boolean) => void
  feedColorMap: Record<string, string>
  googleConnected?: boolean
  onEditEvent?: (eventId: string, data: {
    summary?: string
    description?: string
    location?: string
    start?: { dateTime: string; timeZone: string }
    end?: { dateTime: string; timeZone: string }
  }) => Promise<void>
  onDeleteEvent?: (eventId: string) => Promise<void>
  /** Delete a local entity event */
  onDeleteEntity?: (id: string) => void
}

function isICalEvent(e: Entity | ICalEvent): e is ICalEvent {
  return 'source' in e && (e as ICalEvent).source === 'ical'
}

function toLocalDateTimeValue(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  const h = String(date.getHours()).padStart(2, '0')
  const min = String(date.getMinutes()).padStart(2, '0')
  return `${y}-${m}-${d}T${h}:${min}`
}

export function EventDetailSheet({
  event,
  open,
  onOpenChange,
  feedColorMap,
  googleConnected,
  onEditEvent,
  onDeleteEvent,
  onDeleteEntity,
}: EventDetailSheetProps) {
  const [editOpen, setEditOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)

  if (!event) return null

  const isIcal = isICalEvent(event)

  const color = isIcal
    ? (event.color ?? feedColorMap[event.sourceUrl] ?? '#6b7280')
    : (GCAL_COLORS[event.type] ?? '#616161')

  // Show edit/delete for Google Calendar events when connected
  const canEdit = isIcal && googleConnected && !!onEditEvent
  const canDelete = isIcal && googleConnected && !!onDeleteEvent
  const canDeleteLocal = !isIcal && !!onDeleteEntity

  const handleDelete = async () => {
    if (isIcal && onDeleteEvent) {
      setDeleting(true)
      try {
        await onDeleteEvent(event.id)
        setConfirmDelete(false)
        onOpenChange(false)
      } catch {
        // Error handled upstream
      } finally {
        setDeleting(false)
      }
    } else if (!isIcal && onDeleteEntity) {
      onDeleteEntity(event.id)
      setConfirmDelete(false)
      onOpenChange(false)
    }
  }

  return (
    <>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetContent side="bottom" className="rounded-t-2xl max-h-[70vh]" showCloseButton={false}>
          {/* Drag handle */}
          <div className="flex justify-center pt-2 pb-1">
            <div className="w-10 h-1 rounded-full bg-muted-foreground/30" />
          </div>

          <SheetHeader className="px-5 pb-3">
            {/* Color accent bar */}
            <div className="flex items-start gap-3">
              <div
                className="w-1.5 rounded-full mt-0.5 shrink-0"
                style={{ backgroundColor: color, height: '2rem' }}
              />
              <div className="flex-1 min-w-0">
                <SheetTitle className="text-lg font-medium leading-snug">
                  {event.title}
                </SheetTitle>
                <SheetDescription className="sr-only">Event details</SheetDescription>
              </div>
            </div>
          </SheetHeader>

          <div className="px-5 pb-6 space-y-4">
            {/* Time */}
            {isIcal && (
              <div className="flex items-start gap-3 text-sm">
                <Clock className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                <div>
                  {event.isAllDay ? (
                    <p className="text-foreground">All day</p>
                  ) : (
                    <p className="text-foreground">
                      {event.start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                      {' – '}
                      {event.end.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    </p>
                  )}
                  <p className="text-muted-foreground text-xs mt-0.5">
                    {event.start.toLocaleDateString('en-US', {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </p>
                </div>
              </div>
            )}

            {/* Date for entities */}
            {!isIcal && event.dueDate && (
              <div className="flex items-start gap-3 text-sm">
                <Calendar className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                <div>
                  <p className="text-foreground">
                    {new Date(event.dueDate + 'T00:00:00').toLocaleDateString('en-US', {
                      weekday: 'long',
                      month: 'long',
                      day: 'numeric',
                      year: 'numeric',
                    })}
                  </p>
                </div>
              </div>
            )}

            {/* Location */}
            {isIcal && event.location && (
              <div className="flex items-start gap-3 text-sm">
                <MapPin className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                <p className="text-foreground">{event.location}</p>
              </div>
            )}

            {/* Entity type & status */}
            {!isIcal && (
              <div className="flex items-start gap-3 text-sm">
                <Tag className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                <div className="flex flex-wrap gap-1.5">
                  <Badge
                    className="text-xs capitalize"
                    style={{ backgroundColor: `${color}20`, color, border: 'none' }}
                  >
                    {event.type}
                  </Badge>
                  <Badge variant="outline" className="text-xs capitalize">
                    {event.status}
                  </Badge>
                </div>
              </div>
            )}

            {/* Priority for entities */}
            {!isIcal && (
              <div className="flex items-start gap-3 text-sm">
                <Flag className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                <p className="text-foreground capitalize">{event.priority} priority</p>
              </div>
            )}

            {/* Description */}
            {((isIcal && event.description) || (!isIcal && event.description)) && (
              <div className="pt-2 border-t">
                <p className="text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">
                  {event.description}
                </p>
              </div>
            )}

            {/* Source for iCal */}
            {isIcal && (
              <div className="pt-2 border-t">
                <p className="text-xs text-muted-foreground/60">
                  From {event.sourceName}
                </p>
              </div>
            )}

            {/* Tags for entities */}
            {!isIcal && event.tags.length > 0 && (
              <div className="pt-2 border-t flex flex-wrap gap-1.5">
                {event.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}

            {/* Edit/Delete actions */}
            {(canEdit || canDelete || canDeleteLocal) && (
              <div className="pt-3 border-t flex gap-2">
                {canEdit && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1"
                    onClick={() => setEditOpen(true)}
                  >
                    <Pencil className="w-3.5 h-3.5 mr-1.5" />
                    Edit
                  </Button>
                )}
                {(canDelete || canDeleteLocal) && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => setConfirmDelete(true)}
                  >
                    <Trash2 className="w-3.5 h-3.5 mr-1.5" />
                    Delete
                  </Button>
                )}
              </div>
            )}
          </div>
        </SheetContent>
      </Sheet>

      {/* Edit dialog */}
      {isIcal && canEdit && (
        <EditEventDialog
          event={event}
          open={editOpen}
          onOpenChange={setEditOpen}
          onSave={async (data) => {
            await onEditEvent!(event.id, data)
            setEditOpen(false)
            onOpenChange(false)
          }}
        />
      )}

      {/* Delete confirmation dialog */}
      <Dialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Delete Event</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &ldquo;{event.title}&rdquo;?{isIcal ? ' This will remove it from Google Calendar.' : ''}
            </DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleting}
            >
              {deleting && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
              Delete
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

// ---------------------------------------------------------------------------
// Edit Event Dialog
// ---------------------------------------------------------------------------

function EditEventDialog({
  event,
  open,
  onOpenChange,
  onSave,
}: {
  event: ICalEvent
  open: boolean
  onOpenChange: (open: boolean) => void
  onSave: (data: {
    summary?: string
    description?: string
    location?: string
    start?: { dateTime: string; timeZone: string }
    end?: { dateTime: string; timeZone: string }
  }) => Promise<void>
}) {
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone

  const [summary, setSummary] = useState(event.title)
  const [description, setDescription] = useState(event.description || '')
  const [location, setLocation] = useState(event.location || '')
  const [startDt, setStartDt] = useState(toLocalDateTimeValue(event.start))
  const [endDt, setEndDt] = useState(toLocalDateTimeValue(event.end))
  const [saving, setSaving] = useState(false)

  const handleSave = async () => {
    setSaving(true)
    try {
      await onSave({
        summary,
        description: description || undefined,
        location: location || undefined,
        start: { dateTime: new Date(startDt).toISOString(), timeZone: tz },
        end: { dateTime: new Date(endDt).toISOString(), timeZone: tz },
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Edit Event</DialogTitle>
          <DialogDescription>Modify this Google Calendar event.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="edit-summary">Title</Label>
            <Input id="edit-summary" value={summary} onChange={(e) => setSummary(e.target.value)} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label htmlFor="edit-start">Start</Label>
              <Input id="edit-start" type="datetime-local" value={startDt} onChange={(e) => setStartDt(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="edit-end">End</Label>
              <Input id="edit-end" type="datetime-local" value={endDt} onChange={(e) => setEndDt(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="edit-location">Location</Label>
            <Input id="edit-location" value={location} onChange={(e) => setLocation(e.target.value)} placeholder="Optional" />
          </div>
          <div>
            <Label htmlFor="edit-description">Description</Label>
            <Textarea id="edit-description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} placeholder="Optional" />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={!summary.trim() || saving}>
              {saving && <Loader2 className="w-3.5 h-3.5 mr-1 animate-spin" />}
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
