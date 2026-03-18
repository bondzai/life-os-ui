import { useState, useMemo } from 'react'
import { Sparkles, Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useEntities } from '@/core/hooks'
import { useAIStore } from '@/stores/ai-store'
import { AIClient, gatherContext, buildDailyBriefPrompt } from '@/core/ai'

const CACHE_KEY = 'lyra:daily-brief'

function getCachedBrief(): string | null {
  const raw = sessionStorage.getItem(CACHE_KEY)
  if (!raw) return null
  try {
    const { date, content } = JSON.parse(raw)
    if (date === new Date().toISOString().split('T')[0]) return content
  } catch {
    // ignore
  }
  return null
}

function cacheBrief(content: string) {
  sessionStorage.setItem(
    CACHE_KEY,
    JSON.stringify({ date: new Date().toISOString().split('T')[0], content }),
  )
}

export function DailyBriefWidget() {
  const { items: allEntities } = useEntities()
  const config = useAIStore((s) => s.config)
  const isConfigured = useAIStore((s) => s.isConfigured)

  const [brief, setBrief] = useState<string | null>(getCachedBrief)
  const [loading, setLoading] = useState(false)

  const today = new Date().toISOString().split('T')[0]

  const stats = useMemo(() => {
    const tasks = allEntities.filter((e) => e.type === 'task')
    const dueToday = tasks.filter(
      (e) => e.status !== 'completed' && e.status !== 'archived' && e.dueDate === today,
    ).length
    const overdue = tasks.filter(
      (e) =>
        e.status !== 'completed' &&
        e.status !== 'archived' &&
        e.dueDate &&
        e.dueDate < today,
    ).length
    const activeGoals = allEntities.filter(
      (e) => e.type === 'goal' && e.status === 'active',
    ).length
    const activeHabits = allEntities.filter(
      (e) => e.type === 'habit' && e.status === 'active',
    ).length

    return { dueToday, overdue, activeGoals, activeHabits }
  }, [allEntities, today])

  const generateBrief = async () => {
    if (!isConfigured) return
    setLoading(true)
    try {
      const context = await gatherContext()
      const systemPrompt = buildDailyBriefPrompt(context)
      const client = new AIClient(config)
      const response = await client.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: 'Generate my daily brief for today.' },
      ])
      setBrief(response)
      cacheBrief(response)
    } catch (error) {
      setBrief(`Error: ${error instanceof Error ? error.message : 'Failed to generate brief'}`)
    } finally {
      setLoading(false)
    }
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Sparkles className="h-4 w-4 text-muted-foreground" />
          Daily Brief
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-md bg-muted p-2 text-center">
            <p className="text-lg font-semibold">{stats.dueToday}</p>
            <p className="text-[10px] text-muted-foreground">Due Today</p>
          </div>
          <div className="rounded-md bg-muted p-2 text-center">
            <p className="text-lg font-semibold text-destructive">{stats.overdue}</p>
            <p className="text-[10px] text-muted-foreground">Overdue</p>
          </div>
          <div className="rounded-md bg-muted p-2 text-center">
            <p className="text-lg font-semibold">{stats.activeGoals}</p>
            <p className="text-[10px] text-muted-foreground">Active Goals</p>
          </div>
          <div className="rounded-md bg-muted p-2 text-center">
            <p className="text-lg font-semibold">{stats.activeHabits}</p>
            <p className="text-[10px] text-muted-foreground">Habits</p>
          </div>
        </div>

        {brief ? (
          <div className="text-sm whitespace-pre-wrap border-t pt-3">{brief}</div>
        ) : isConfigured ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={generateBrief}
            disabled={loading}
          >
            {loading ? (
              <>
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="h-3.5 w-3.5 mr-1.5" />
                Generate Brief
              </>
            )}
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}
