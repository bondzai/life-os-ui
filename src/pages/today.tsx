import { useState, useMemo, useCallback } from 'react'
import { CheckSquare, ClipboardList, CalendarDays, Sun, Inbox, ArrowRight } from 'lucide-react'
import { useNavigate } from 'react-router'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { useEntities, useTrackers } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { notify } from '@/lib/notify'
import { PriorityPicker } from './today/priority-picker'
import { TodayChecklist } from './today/today-checklist'
import { HabitStrip } from './today/habit-strip'
import { QuickJournal } from './today/quick-journal'
import { getTodayPriorities, setTodayPriorities } from './today/today-helpers'
import type { Entity } from '@/core/types'

export function TodayPage() {
  const { items: allEntities, update, create } = useEntities()
  const { items: allTrackers, create: createTracker } = useTrackers()
  const currentUser = useAuthStore((s) => s.currentUser)
  const navigate = useNavigate()

  const [priorities, setPriorities] = useState<string[]>(() => getTodayPriorities())

  const today = new Date().toISOString().split('T')[0]
  const todayStart = useMemo(() => {
    const d = new Date()
    d.setHours(0, 0, 0, 0)
    return d.toISOString()
  }, [])

  // Priority entities
  const priorityEntities = useMemo(
    () => priorities.map((id) => allEntities.find((e) => e.id === id)).filter(Boolean) as Entity[],
    [priorities, allEntities],
  )

  // Candidates for priority picker: active tasks and goals
  const priorityCandidates = useMemo(
    () =>
      allEntities.filter(
        (e) =>
          (e.type === 'task' || e.type === 'goal') &&
          e.status === 'active',
      ),
    [allEntities],
  )

  // Due tasks
  const dueTasks = useMemo(
    () =>
      allEntities.filter(
        (e) =>
          e.type === 'task' &&
          e.status !== 'completed' &&
          e.status !== 'archived' &&
          e.dueDate &&
          e.dueDate <= today,
      ),
    [allEntities, today],
  )

  // Due chores
  const dueChores = useMemo(
    () =>
      allEntities.filter(
        (e) =>
          e.type === 'chore' &&
          e.status !== 'completed' &&
          e.status !== 'archived' &&
          e.dueDate &&
          e.dueDate <= today,
      ),
    [allEntities, today],
  )

  // Today's events
  const todayEvents = useMemo(
    () =>
      allEntities.filter(
        (e) => e.type === 'event' && e.status === 'active' && e.dueDate === today,
      ),
    [allEntities, today],
  )

  // Habits with check-in status
  const habits = useMemo(
    () =>
      allEntities
        .filter((e) => e.type === 'habit' && e.status === 'active')
        .map((habit) => ({
          habit,
          checkedToday: allTrackers.some(
            (t) => t.entityId === habit.id && t.timestamp >= todayStart,
          ),
          streak: typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0,
        })),
    [allEntities, allTrackers, todayStart],
  )

  // Inbox items
  const inboxItems = useMemo(
    () =>
      allEntities.filter(
        (e) => e.type === 'note' && e.metadata.isInbox === true && e.status === 'active',
      ),
    [allEntities],
  )

  // Overall progress
  const allDueItems = [...dueTasks, ...dueChores]
  const completedCount = allDueItems.filter((i) => i.status === 'completed').length
  const habitsChecked = habits.filter((h) => h.checkedToday).length
  const totalItems = allDueItems.length + habits.length
  const doneItems = completedCount + habitsChecked
  const progressPercent = totalItems > 0 ? Math.round((doneItems / totalItems) * 100) : 100

  const handleSavePriorities = useCallback((ids: string[]) => {
    setTodayPriorities(ids)
    setPriorities(ids)
    notify({ title: 'Priorities set', type: 'success' })
  }, [])

  const toggleItem = useCallback(
    (item: Entity) => {
      update.mutate({
        id: item.id,
        updates: {
          status: item.status === 'completed' ? 'active' : 'completed',
          updatedAt: new Date().toISOString(),
        },
      })
    },
    [update],
  )

  const handleHabitCheckIn = useCallback(
    (habit: Entity) => {
      createTracker.mutate({
        id: crypto.randomUUID(),
        entityId: habit.id,
        value: 1,
        unit: 'done',
        timestamp: new Date().toISOString(),
        ownerId: currentUser?.id ?? '',
      })
      // Increment streak
      const currentStreak = typeof habit.metadata.streak === 'number' ? (habit.metadata.streak as number) : 0
      update.mutate({
        id: habit.id,
        updates: {
          metadata: { ...habit.metadata, streak: currentStreak + 1 },
          updatedAt: new Date().toISOString(),
        },
      })
      notify({ title: `${habit.title} checked in!`, type: 'success' })
    },
    [createTracker, update, currentUser],
  )

  const handleJournalSave = useCallback(
    (text: string) => {
      create.mutate({
        id: crypto.randomUUID(),
        type: 'note',
        title: `Journal — ${new Date().toLocaleDateString()}`,
        status: 'active',
        priority: 'low',
        tags: ['journal'],
        metadata: { body: text, isJournal: true, date: today, mood: '' },
        ownerId: currentUser?.id ?? '',
        visibility: 'private',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      notify({ title: 'Journal entry saved', type: 'success' })
    },
    [create, currentUser, today],
  )

  const handleConvertToTask = useCallback(
    (item: Entity) => {
      create.mutate({
        id: crypto.randomUUID(),
        type: 'task',
        title: item.title,
        description: typeof item.metadata.body === 'string' ? (item.metadata.body as string) : undefined,
        status: 'active',
        priority: 'medium',
        tags: [],
        metadata: {},
        ownerId: currentUser?.id ?? '',
        visibility: 'private',
        dueDate: today,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })
      update.mutate({
        id: item.id,
        updates: { status: 'archived', updatedAt: new Date().toISOString() },
      })
      notify({ title: 'Converted to task', type: 'success' })
    },
    [create, update, currentUser, today],
  )

  const handleArchiveInbox = useCallback(
    (item: Entity) => {
      update.mutate({
        id: item.id,
        updates: { status: 'archived', updatedAt: new Date().toISOString() },
      })
      notify({ title: 'Archived', type: 'success' })
    },
    [update],
  )

  return (
    <div className="space-y-4 max-w-2xl">
      {/* Progress bar */}
      <Card>
        <CardContent className="p-3 flex items-center gap-3">
          <Sun className="h-5 w-5 text-yellow-500 shrink-0" />
          <div className="flex-1 space-y-1">
            <div className="flex justify-between text-sm">
              <span className="font-medium">Today's Progress</span>
              <span className="text-muted-foreground">{doneItems} of {totalItems} done</span>
            </div>
            <Progress value={progressPercent} className="h-2" />
          </div>
        </CardContent>
      </Card>

      {/* Priorities */}
      {priorities.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2 text-sm font-medium">
                <span className="text-yellow-500">&#9733;</span> Today's Priorities
              </CardTitle>
              <Button
                size="sm"
                variant="ghost"
                className="text-xs h-7"
                onClick={() => {
                  setTodayPriorities([])
                  setPriorities([])
                }}
              >
                Reset
              </Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {priorityEntities.map((item) => (
                <div key={item.id} className="flex items-center gap-2">
                  <CheckSquare
                    className={`h-4 w-4 shrink-0 ${
                      item.status === 'completed' ? 'text-green-500' : 'text-muted-foreground'
                    }`}
                  />
                  <span
                    className={`text-sm flex-1 ${
                      item.status === 'completed' ? 'line-through text-muted-foreground' : 'font-medium'
                    }`}
                  >
                    {item.title}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ) : (
        <PriorityPicker candidates={priorityCandidates} onSave={handleSavePriorities} />
      )}

      {/* Due Tasks */}
      <TodayChecklist
        title="Due Tasks"
        icon={<CheckSquare className="h-4 w-4 text-muted-foreground" />}
        items={dueTasks}
        onToggle={toggleItem}
      />

      {/* Due Chores */}
      {dueChores.length > 0 && (
        <TodayChecklist
          title="Due Chores"
          icon={<ClipboardList className="h-4 w-4 text-muted-foreground" />}
          items={dueChores}
          onToggle={toggleItem}
        />
      )}

      {/* Today's Events */}
      {todayEvents.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <CalendarDays className="h-4 w-4 text-muted-foreground" />
              Today's Events
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {todayEvents.map((event) => (
                <div key={event.id} className="flex items-center gap-2 text-sm">
                  <span className="w-2 h-2 rounded-full bg-primary shrink-0" />
                  <span className="truncate">{event.title}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Habits */}
      <HabitStrip habits={habits} onCheckIn={handleHabitCheckIn} />

      {/* Inbox Items */}
      {inboxItems.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm font-medium">
              <Inbox className="h-4 w-4 text-muted-foreground" />
              Inbox
              <span className="text-xs text-muted-foreground ml-auto">{inboxItems.length} items</span>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              {inboxItems.map((item) => (
                <div key={item.id} className="flex items-center gap-2">
                  <span className="text-sm truncate flex-1">{item.title}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => handleConvertToTask(item)}
                  >
                    <ArrowRight className="h-3 w-3 mr-1" /> Task
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    onClick={() => handleArchiveInbox(item)}
                  >
                    Archive
                  </Button>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Quick Journal */}
      <QuickJournal onSave={handleJournalSave} />

      {/* Weekly Review link */}
      <div className="flex justify-center pt-2">
        <Button variant="outline" size="sm" onClick={() => navigate('/review')}>
          Start Weekly Review
        </Button>
      </div>
    </div>
  )
}
