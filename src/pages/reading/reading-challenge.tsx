import { useState } from 'react'
import { Trophy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'

export function ReadingChallenge() {
  const { items: goals, create } = useEntities('goal')
  const { items: allEntities } = useEntities()
  const currentUser = useAuthStore((s) => s.currentUser)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [targetBooks, setTargetBooks] = useState('12')
  const [targetYear, setTargetYear] = useState(new Date().getFullYear().toString())

  // Find active reading challenges
  const challenges = goals.filter(
    (g) => g.metadata.challengeType === 'reading' && g.status === 'todo',
  )

  const getCompletedBooks = (year: string) =>
    allEntities.filter(
      (e) =>
        e.type === 'book' &&
        e.status === 'done' &&
        e.updatedAt.startsWith(year),
    ).length

  const handleCreate = () => {
    const target = parseInt(targetBooks, 10)
    if (!target || target <= 0) return

    create.mutate({
      id: crypto.randomUUID(),
      type: 'goal',
      title: `Read ${target} books in ${targetYear}`,
      description: `Annual reading challenge for ${targetYear}`,
      status: 'todo',
      priority: 'medium',
      tags: ['reading', 'challenge'],
      metadata: {
        challengeType: 'reading',
        targetYear,
        targetBooks: target,
        progress: 0,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'shared',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Reading challenge started!', type: 'success' })
    setDialogOpen(false)
  }

  if (challenges.length === 0) {
    return (
      <>
        <Button size="sm" variant="outline" onClick={() => setDialogOpen(true)}>
          <Trophy className="h-4 w-4 mr-1" /> Start Reading Challenge
        </Button>
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Start Reading Challenge</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1">
                <label className="text-sm">Year</label>
                <Input
                  type="number"
                  value={targetYear}
                  onChange={(e) => setTargetYear(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm">Target books</label>
                <Input
                  type="number"
                  value={targetBooks}
                  onChange={(e) => setTargetBooks(e.target.value)}
                  min={1}
                />
              </div>
            </div>
            <DialogFooter>
              <Button onClick={handleCreate}>Start Challenge</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </>
    )
  }

  return (
    <div className="space-y-3">
      {challenges.map((challenge) => {
        const year = challenge.metadata.targetYear as string
        const target = challenge.metadata.targetBooks as number
        const completed = getCompletedBooks(year)
        const pct = Math.min(100, Math.round((completed / target) * 100))

        return (
          <Card key={challenge.id}>
            <CardHeader className="pb-2">
              <div className="flex items-center gap-2">
                <Trophy className="h-4 w-4 text-amber-500" />
                <CardTitle className="text-sm font-medium">{challenge.title}</CardTitle>
              </div>
            </CardHeader>
            <CardContent className="space-y-2">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">
                  {completed} of {target} books
                </span>
                <span className="font-medium">{pct}%</span>
              </div>
              <Progress value={pct} />
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
