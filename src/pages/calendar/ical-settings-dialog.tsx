import { useState } from 'react'
import { Trash2, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import type { ICalFeed } from '@/lib/ical'
import { normalizeGCalUrl } from '@/lib/ical/fetch'
import { hasGCalApiKey, extractCalendarId } from '@/lib/ical/gcal-api'

const PRESET_COLORS = [
  '#3b82f6', // blue
  '#ef4444', // red
  '#22c55e', // green
  '#f59e0b', // amber
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#06b6d4', // cyan
  '#f97316', // orange
]

interface ICalSettingsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  feeds: ICalFeed[]
  onAdd: (feed: ICalFeed) => void | Promise<void>
  onRemove: (id: string) => void
  onToggle: (id: string) => void
}

export function ICalSettingsDialog({
  open,
  onOpenChange,
  feeds,
  onAdd,
  onRemove,
  onToggle,
}: ICalSettingsDialogProps) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [color, setColor] = useState(PRESET_COLORS[0])
  const [adding, setAdding] = useState(false)

  const isGoogleUrl = url.trim() ? !!extractCalendarId(url.trim()) : false
  const willAutoColor = isGoogleUrl && hasGCalApiKey()

  const handleAdd = async () => {
    if (!name.trim() || !url.trim()) return
    setAdding(true)
    try {
      await onAdd({
        id: crypto.randomUUID(),
        name: name.trim(),
        url: normalizeGCalUrl(url.trim()),
        color,
        enabled: true,
      })
    } finally {
      setAdding(false)
    }
    setName('')
    setUrl('')
    setColor(PRESET_COLORS[0])
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Calendar Feeds</DialogTitle>
          <DialogDescription>
            Add iCal URLs to import events from Google Calendar or other providers.
          </DialogDescription>
        </DialogHeader>

        {/* Existing feeds */}
        {feeds.length > 0 && (
          <div className="space-y-2">
            {feeds.map((feed) => (
              <div
                key={feed.id}
                className="flex items-center gap-2 p-2 rounded-md border"
              >
                <button
                  type="button"
                  className="w-3 h-3 rounded-full shrink-0 border"
                  style={{ backgroundColor: feed.enabled ? feed.color : 'transparent', borderColor: feed.color }}
                  onClick={() => onToggle(feed.id)}
                  title={feed.enabled ? 'Disable' : 'Enable'}
                />
                <span className={`text-sm flex-1 truncate ${!feed.enabled ? 'text-muted-foreground line-through' : ''}`}>
                  {feed.name}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 w-7 p-0"
                  onClick={() => onRemove(feed.id)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Add feed form */}
        <div className="space-y-3 border-t pt-3">
          <h4 className="text-sm font-medium">Add Feed</h4>
          <div className="space-y-2">
            <div>
              <Label htmlFor="feed-name">Name</Label>
              <Input
                id="feed-name"
                placeholder="e.g. Work Calendar"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="feed-url">iCal URL</Label>
              <Input
                id="feed-url"
                placeholder="https://calendar.google.com/calendar/ical/..."
                value={url}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div>
              <Label>Color</Label>
              {willAutoColor ? (
                <p className="text-xs text-muted-foreground mt-1">
                  Auto-detected from Google Calendar
                </p>
              ) : (
                <div className="flex gap-2 mt-1">
                  {PRESET_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      className={`w-6 h-6 rounded-full border-2 transition-transform ${
                        color === c ? 'border-foreground scale-110' : 'border-transparent'
                      }`}
                      style={{ backgroundColor: c }}
                      onClick={() => setColor(c)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={handleAdd} disabled={!name.trim() || !url.trim() || adding}>
              {adding && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
              Add Feed
            </Button>
            {isGoogleUrl && (
              <span className="text-[11px] text-muted-foreground">
                {hasGCalApiKey() ? 'Google Calendar API ✓' : 'Add VITE_GCAL_API_KEY for colors'}
              </span>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
