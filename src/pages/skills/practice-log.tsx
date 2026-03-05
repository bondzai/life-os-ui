import { useState } from 'react'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'

interface PracticeLogProps {
  skillId: string
}

export function PracticeLog({ skillId }: PracticeLogProps) {
  const { items: allTrackers, create } = useTrackers(skillId)
  const currentUser = useAuthStore((s) => s.currentUser)

  const [logging, setLogging] = useState(false)
  const [duration, setDuration] = useState('')
  const [note, setNote] = useState('')

  const trackers = allTrackers
    .filter((t) => t.entityId === skillId)
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  const totalSessions = trackers.length
  const lastPracticed = trackers[0]?.timestamp

  const handleLog = () => {
    const mins = parseInt(duration, 10)
    if (!mins || mins <= 0) return
    create.mutate({
      id: crypto.randomUUID(),
      entityId: skillId,
      value: mins,
      unit: 'session',
      note: note.trim() || undefined,
      timestamp: new Date().toISOString(),
      ownerId: currentUser?.id ?? '',
    })
    setDuration('')
    setNote('')
    setLogging(false)
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium">Practice Log</h4>
        {!logging && (
          <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setLogging(true)}>
            <Plus className="h-3 w-3 mr-1" /> Log Practice
          </Button>
        )}
      </div>

      {/* Stats */}
      <div className="flex gap-4 text-xs text-muted-foreground">
        <span>Total sessions: {totalSessions}</span>
        {lastPracticed && (
          <span>Last: {new Date(lastPracticed).toLocaleDateString()}</span>
        )}
      </div>

      {/* Inline log form */}
      {logging && (
        <div className="flex gap-2 items-end">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Minutes</label>
            <Input
              type="number"
              value={duration}
              onChange={(e) => setDuration(e.target.value)}
              placeholder="30"
              className="h-7 w-20 text-xs"
              autoFocus
              min={1}
            />
          </div>
          <div className="flex-1 space-y-1">
            <label className="text-xs text-muted-foreground">Note (optional)</label>
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What did you practice?"
              className="h-7 text-xs"
              onKeyDown={(e) => e.key === 'Enter' && handleLog()}
            />
          </div>
          <Button size="sm" className="h-7 text-xs" onClick={handleLog}>
            Save
          </Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setLogging(false)}>
            Cancel
          </Button>
        </div>
      )}

      {/* Recent entries */}
      {trackers.slice(0, 5).length > 0 && (
        <div className="space-y-1">
          {trackers.slice(0, 5).map((t) => (
            <div key={t.id} className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="w-20 shrink-0">{new Date(t.timestamp).toLocaleDateString()}</span>
              <span className="font-medium text-foreground">{t.value} min</span>
              {t.note && <span className="truncate">— {t.note}</span>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
