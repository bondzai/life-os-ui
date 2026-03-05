import { useState, useMemo } from 'react'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { getRuns, clearRuns, type AutomationRun } from './automation-runs'

interface AutomationHistoryProps {
  automationNames: { id: string; title: string }[]
}

export function AutomationHistory({ automationNames }: AutomationHistoryProps) {
  const [runs, setRuns] = useState<AutomationRun[]>(() => getRuns())
  const [filterAutomation, setFilterAutomation] = useState('all')

  const filtered = useMemo(() => {
    if (filterAutomation === 'all') return runs
    return runs.filter((r) => r.automationId === filterAutomation)
  }, [runs, filterAutomation])

  const handleClear = () => {
    clearRuns()
    setRuns([])
  }

  // Unique automation IDs from runs
  const uniqueAutomations = useMemo(() => {
    const seen = new Map<string, string>()
    for (const r of runs) {
      if (!seen.has(r.automationId)) seen.set(r.automationId, r.automationTitle)
    }
    // Merge with current automations
    for (const a of automationNames) {
      if (!seen.has(a.id)) seen.set(a.id, a.title)
    }
    return Array.from(seen.entries()).map(([id, title]) => ({ id, title }))
  }, [runs, automationNames])

  if (runs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground text-center py-8">
        No execution history yet.
      </p>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <Select value={filterAutomation} onValueChange={setFilterAutomation}>
          <SelectTrigger className="w-[200px]">
            <SelectValue placeholder="Filter automation" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Automations</SelectItem>
            {uniqueAutomations.map((a) => (
              <SelectItem key={a.id} value={a.id}>
                {a.title}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" variant="outline" onClick={handleClear}>
          <Trash2 className="h-3.5 w-3.5 mr-1" /> Clear All
        </Button>
      </div>

      <div className="border rounded-md overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="text-left p-2 font-medium">Date</th>
              <th className="text-left p-2 font-medium">Automation</th>
              <th className="text-left p-2 font-medium">Result</th>
              <th className="text-left p-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, 50).map((run) => (
              <tr key={run.id} className="border-t">
                <td className="p-2 text-xs text-muted-foreground whitespace-nowrap">
                  {new Date(run.timestamp).toLocaleString()}
                </td>
                <td className="p-2 text-xs">{run.automationTitle}</td>
                <td className="p-2">
                  <Badge
                    variant={run.result === 'success' ? 'default' : 'destructive'}
                    className="text-xs"
                  >
                    {run.result}
                  </Badge>
                </td>
                <td className="p-2 text-xs text-muted-foreground truncate max-w-[200px]">
                  {run.details ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
