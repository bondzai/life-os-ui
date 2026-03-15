import { useState } from 'react'
import { Trash2, Loader2, Check, Unplug } from 'lucide-react'
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
import { extractCalendarId } from '@/lib/ical/gcal-api'

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
  googleConnected?: boolean
  onGoogleConnect?: () => void
  onGoogleDisconnect?: () => void
}

export function ICalSettingsDialog({
  open,
  onOpenChange,
  feeds,
  onAdd,
  onRemove,
  onToggle,
  googleConnected,
  onGoogleConnect,
  onGoogleDisconnect,
}: ICalSettingsDialogProps) {
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [color, setColor] = useState(PRESET_COLORS[0])
  const [adding, setAdding] = useState(false)

  const isGoogleUrl = url.trim() ? !!extractCalendarId(url.trim()) : false

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

        {/* Google Calendar OAuth connection */}
        {onGoogleConnect && (
          <div className="flex items-center justify-between p-3 rounded-lg border bg-muted/30">
            <div className="flex items-center gap-2.5">
              <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
              </svg>
              <div>
                <p className="text-sm font-medium">Google Calendar</p>
                {googleConnected ? (
                  <p className="text-xs text-green-600 flex items-center gap-1">
                    <Check className="w-3 h-3" /> Connected
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">Connect to create, edit, and delete events</p>
                )}
              </div>
            </div>
            {googleConnected ? (
              <Button
                variant="outline"
                size="sm"
                className="h-7 text-xs"
                onClick={onGoogleDisconnect}
              >
                <Unplug className="w-3 h-3 mr-1" />
                Disconnect
              </Button>
            ) : (
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={onGoogleConnect}
              >
                Connect
              </Button>
            )}
          </div>
        )}

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
              <Label>Color {isGoogleUrl && <span className="text-xs text-muted-foreground font-normal ml-1">(auto-detected for Google)</span>}</Label>
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
            </div>
          </div>
          <Button size="sm" onClick={handleAdd} disabled={!name.trim() || !url.trim() || adding}>
            {adding && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Add Feed
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
