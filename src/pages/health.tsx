import { useState, useMemo } from 'react'
import { Plus, Heart, Dumbbell, Moon, Activity, Scale } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useEntities } from '@/core/hooks'
import { useAuthStore } from '@/stores/auth-store'
import { EmptyState } from '@/core/components/empty-state'
import { ConfirmDialog } from '@/core/components/confirm-dialog'
import { notify } from '@/lib/notify'
import {
  BODY_METRIC_TYPES,
  WORKOUT_TYPES,
  type BodyMetricType,
  type WorkoutType,
  type MoodLevel,
  type SleepQuality,
} from './health/health-helpers'
import { BodyMetricDialog, type BodyMetricFormValues } from './health/body-metric-dialog'
import { WorkoutDialog, type WorkoutFormValues } from './health/workout-dialog'
import { SleepMoodDialog, type SleepMoodFormValues } from './health/sleep-mood-dialog'
import { BodyMetricTable } from './health/body-metric-table'
import { WorkoutCard } from './health/workout-card'
import { SleepMoodCard } from './health/sleep-mood-card'
import { WeightChart } from './health/weight-chart'
import { SleepChart } from './health/sleep-chart'
import { WorkoutHeatmap } from './health/workout-heatmap'
import { WaterIntakeCard } from './health/water-intake-card'
import { HealthMetricsCard } from './health/health-metrics-card'
import type { Entity } from '@/core/types'

export function HealthPage() {
  const { items: bodyMetrics, create: createMetric, update: updateMetric, remove: removeMetric } = useEntities('body-metric')
  const { items: workouts, create: createWorkout, update: updateWorkout, remove: removeWorkout } = useEntities('workout')
  const { items: sleepMoods, create: createSleepMood, update: updateSleepMood, remove: removeSleepMood } = useEntities('sleep-mood')
  const currentUser = useAuthStore((s) => s.currentUser)

  const [tab, setTab] = useState('body')
  const [metricTypeFilter, setMetricTypeFilter] = useState('all')
  const [workoutTypeFilter, setWorkoutTypeFilter] = useState('all')

  // Dialogs
  const [metricDialogOpen, setMetricDialogOpen] = useState(false)
  const [workoutDialogOpen, setWorkoutDialogOpen] = useState(false)
  const [sleepMoodDialogOpen, setSleepMoodDialogOpen] = useState(false)
  const [editingMetric, setEditingMetric] = useState<Entity | null>(null)
  const [editingWorkout, setEditingWorkout] = useState<Entity | null>(null)
  const [editingSleepMood, setEditingSleepMood] = useState<Entity | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ entity: Entity; type: 'body-metric' | 'workout' | 'sleep-mood' } | null>(null)

  // Summary stats
  const latestWeight = useMemo(() => {
    const weights = bodyMetrics
      .filter((m) => m.metadata.metricType === 'weight')
      .sort((a, b) => ((b.metadata.date as string) || '').localeCompare((a.metadata.date as string) || ''))
    return weights[0]?.metadata.value as number | undefined
  }, [bodyMetrics])

  const thisWeekWorkouts = useMemo(() => {
    const now = new Date()
    const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString().split('T')[0]
    return workouts.filter((w) => ((w.metadata.date as string) || '') >= weekAgo).length
  }, [workouts])

  const todayMood = useMemo(() => {
    const today = new Date().toISOString().split('T')[0]
    const entry = sleepMoods.find((s) => s.metadata.date === today)
    return entry?.metadata.mood as string | undefined
  }, [sleepMoods])

  const avgSleep = useMemo(() => {
    const recent = sleepMoods
      .filter((s) => s.metadata.sleepHours != null)
      .sort((a, b) => ((b.metadata.date as string) || '').localeCompare((a.metadata.date as string) || ''))
      .slice(0, 7)
    if (recent.length === 0) return undefined
    const total = recent.reduce((sum, s) => sum + (s.metadata.sleepHours as number), 0)
    return (total / recent.length).toFixed(1)
  }, [sleepMoods])

  // Filtered lists
  const filteredMetrics = useMemo(() => {
    let result = bodyMetrics
    if (metricTypeFilter !== 'all') {
      result = result.filter((m) => m.metadata.metricType === metricTypeFilter)
    }
    return result.sort((a, b) => ((b.metadata.date as string) || '').localeCompare((a.metadata.date as string) || ''))
  }, [bodyMetrics, metricTypeFilter])

  const filteredWorkouts = useMemo(() => {
    let result = workouts
    if (workoutTypeFilter !== 'all') {
      result = result.filter((w) => w.metadata.workoutType === workoutTypeFilter)
    }
    return result.sort((a, b) => ((b.metadata.date as string) || '').localeCompare((a.metadata.date as string) || ''))
  }, [workouts, workoutTypeFilter])

  const sortedSleepMoods = useMemo(
    () => [...sleepMoods].sort((a, b) => ((b.metadata.date as string) || '').localeCompare((a.metadata.date as string) || '')),
    [sleepMoods],
  )

  // CRUD handlers
  const handleCreateMetric = (values: BodyMetricFormValues) => {
    const typeLabel = values.metricType === 'body-fat' ? 'Body Fat' : values.metricType === 'bmi' ? 'BMI' : values.metricType.charAt(0).toUpperCase() + values.metricType.slice(1)
    createMetric.mutate({
      id: crypto.randomUUID(),
      type: 'body-metric',
      title: `${typeLabel} — ${values.value}`,
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: {
        metricType: values.metricType,
        value: values.value,
        date: values.date,
        note: values.note,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Body metric logged', type: 'success' })
  }

  const handleEditMetric = (values: BodyMetricFormValues) => {
    if (!editingMetric) return
    const typeLabel = values.metricType === 'body-fat' ? 'Body Fat' : values.metricType === 'bmi' ? 'BMI' : values.metricType.charAt(0).toUpperCase() + values.metricType.slice(1)
    updateMetric.mutate({
      id: editingMetric.id,
      updates: {
        title: `${typeLabel} — ${values.value}`,
        metadata: {
          ...editingMetric.metadata,
          metricType: values.metricType,
          value: values.value,
          date: values.date,
          note: values.note,
        },
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Body metric updated', type: 'success' })
    setEditingMetric(null)
  }

  const handleCreateWorkout = (values: WorkoutFormValues) => {
    createWorkout.mutate({
      id: crypto.randomUUID(),
      type: 'workout',
      title: values.title,
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: {
        workoutType: values.workoutType,
        duration: values.duration,
        calories: values.calories,
        exercises: values.exercises,
        date: values.date,
        note: values.note,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Workout logged', type: 'success' })
  }

  const handleEditWorkout = (values: WorkoutFormValues) => {
    if (!editingWorkout) return
    updateWorkout.mutate({
      id: editingWorkout.id,
      updates: {
        title: values.title,
        metadata: {
          ...editingWorkout.metadata,
          workoutType: values.workoutType,
          duration: values.duration,
          calories: values.calories,
          exercises: values.exercises,
          date: values.date,
          note: values.note,
        },
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Workout updated', type: 'success' })
    setEditingWorkout(null)
  }

  const handleCreateSleepMood = (values: SleepMoodFormValues) => {
    const parts = []
    if (values.sleepHours != null) parts.push(`${values.sleepHours}h sleep`)
    if (values.mood) parts.push(values.mood)
    createSleepMood.mutate({
      id: crypto.randomUUID(),
      type: 'sleep-mood',
      title: parts.join(' / ') || values.date,
      status: 'active',
      priority: 'medium',
      tags: [],
      metadata: {
        sleepHours: values.sleepHours,
        sleepQuality: values.sleepQuality,
        mood: values.mood,
        energy: values.energy,
        date: values.date,
        note: values.note,
      },
      ownerId: currentUser?.id ?? '',
      visibility: 'private',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })
    notify({ title: 'Sleep & mood logged', type: 'success' })
  }

  const handleEditSleepMood = (values: SleepMoodFormValues) => {
    if (!editingSleepMood) return
    const parts = []
    if (values.sleepHours != null) parts.push(`${values.sleepHours}h sleep`)
    if (values.mood) parts.push(values.mood)
    updateSleepMood.mutate({
      id: editingSleepMood.id,
      updates: {
        title: parts.join(' / ') || values.date,
        metadata: {
          ...editingSleepMood.metadata,
          sleepHours: values.sleepHours,
          sleepQuality: values.sleepQuality,
          mood: values.mood,
          energy: values.energy,
          date: values.date,
          note: values.note,
        },
        updatedAt: new Date().toISOString(),
      },
    })
    notify({ title: 'Sleep & mood updated', type: 'success' })
    setEditingSleepMood(null)
  }

  const handleDelete = () => {
    if (!deleteTarget) return
    const { entity, type } = deleteTarget
    if (type === 'body-metric') removeMetric.mutate(entity.id)
    else if (type === 'workout') removeWorkout.mutate(entity.id)
    else removeSleepMood.mutate(entity.id)
    const label = type === 'body-metric' ? 'Body metric' : type === 'sleep-mood' ? 'Sleep & mood entry' : 'Workout'
    notify({ title: `${label} deleted`, type: 'success' })
    setDeleteTarget(null)
  }

  const addButton = (
    <Button
      size="sm"
      onClick={() => {
        if (tab === 'body') setMetricDialogOpen(true)
        else if (tab === 'workouts') setWorkoutDialogOpen(true)
        else setSleepMoodDialogOpen(true)
      }}
    >
      <Plus className="h-4 w-4 mr-1" /> Log
    </Button>
  )

  return (
    <div className="space-y-4">
      {/* Health Metrics — BMI, BMR, TDEE, Weight Trend, Active Minutes */}
      <HealthMetricsCard bodyMetrics={bodyMetrics} workouts={workouts} />

      {/* Summary strip */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Weight</CardTitle>
            <Scale className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{latestWeight != null ? `${latestWeight} kg` : '—'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Workouts (7d)</CardTitle>
            <Dumbbell className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{thisWeekWorkouts}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Avg Sleep (7d)</CardTitle>
            <Moon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{avgSleep != null ? `${avgSleep}h` : '—'}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Today's Mood</CardTitle>
            <Heart className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold capitalize">{todayMood || '—'}</p>
          </CardContent>
        </Card>
        <WaterIntakeCard />
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <TabsList>
            <TabsTrigger value="body">Body Metrics</TabsTrigger>
            <TabsTrigger value="workouts">Workouts</TabsTrigger>
            <TabsTrigger value="sleep-mood">Sleep & Mood</TabsTrigger>
          </TabsList>
          {addButton}
        </div>

        {/* Body Metrics Tab */}
        <TabsContent value="body" className="space-y-4">
          <WeightChart metrics={bodyMetrics} />
          <div className="flex gap-3 flex-wrap">
            <Select value={metricTypeFilter} onValueChange={setMetricTypeFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Metric type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Metrics</SelectItem>
                {BODY_METRIC_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t === 'body-fat' ? 'Body Fat' : t === 'bmi' ? 'BMI' : t.charAt(0).toUpperCase() + t.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {filteredMetrics.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="No body metrics yet"
              description="Log your weight, body fat, or measurements to track progress."
              actionLabel="Log Metric"
              onAction={() => setMetricDialogOpen(true)}
            />
          ) : (
            <BodyMetricTable
              metrics={filteredMetrics}
              onEdit={setEditingMetric}
              onDelete={(m) => setDeleteTarget({ entity: m, type: 'body-metric' })}
            />
          )}
        </TabsContent>

        {/* Workouts Tab */}
        <TabsContent value="workouts" className="space-y-4">
          <div className="flex gap-3 flex-wrap">
            <Select value={workoutTypeFilter} onValueChange={setWorkoutTypeFilter}>
              <SelectTrigger className="w-[160px]">
                <SelectValue placeholder="Workout type" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Types</SelectItem>
                {WORKOUT_TYPES.map((t) => (
                  <SelectItem key={t} value={t}>
                    {t === 'hiit' ? 'HIIT' : t.charAt(0).toUpperCase() + t.slice(1)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <WorkoutHeatmap workouts={workouts} />
          {filteredWorkouts.length === 0 ? (
            <EmptyState
              icon={Dumbbell}
              title="No workouts yet"
              description="Log your first workout to start tracking."
              actionLabel="Log Workout"
              onAction={() => setWorkoutDialogOpen(true)}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredWorkouts.map((workout) => (
                <WorkoutCard
                  key={workout.id}
                  workout={workout}
                  onEdit={setEditingWorkout}
                  onDelete={(w) => setDeleteTarget({ entity: w, type: 'workout' })}
                />
              ))}
            </div>
          )}
        </TabsContent>

        {/* Sleep & Mood Tab */}
        <TabsContent value="sleep-mood" className="space-y-4">
          <SleepChart entries={sleepMoods} />
          {sortedSleepMoods.length === 0 ? (
            <EmptyState
              icon={Moon}
              title="No sleep & mood entries yet"
              description="Log your daily sleep, mood, and energy levels."
              actionLabel="Log Entry"
              onAction={() => setSleepMoodDialogOpen(true)}
            />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {sortedSleepMoods.map((entry) => (
                <SleepMoodCard
                  key={entry.id}
                  entry={entry}
                  onEdit={setEditingSleepMood}
                  onDelete={(e) => setDeleteTarget({ entity: e, type: 'sleep-mood' })}
                />
              ))}
            </div>
          )}
        </TabsContent>
      </Tabs>

      {/* Create dialogs */}
      <BodyMetricDialog
        open={metricDialogOpen}
        onOpenChange={setMetricDialogOpen}
        onSubmit={handleCreateMetric}
      />
      <WorkoutDialog
        open={workoutDialogOpen}
        onOpenChange={setWorkoutDialogOpen}
        onSubmit={handleCreateWorkout}
      />
      <SleepMoodDialog
        open={sleepMoodDialogOpen}
        onOpenChange={setSleepMoodDialogOpen}
        onSubmit={handleCreateSleepMood}
      />

      {/* Edit dialogs */}
      <BodyMetricDialog
        open={!!editingMetric}
        onOpenChange={(open) => !open && setEditingMetric(null)}
        title="Edit Body Metric"
        defaultValues={
          editingMetric
            ? {
                metricType: editingMetric.metadata.metricType as BodyMetricType,
                value: editingMetric.metadata.value as number,
                date: (editingMetric.metadata.date as string) || '',
                note: (editingMetric.metadata.note as string) || '',
              }
            : undefined
        }
        onSubmit={handleEditMetric}
      />
      <WorkoutDialog
        open={!!editingWorkout}
        onOpenChange={(open) => !open && setEditingWorkout(null)}
        title="Edit Workout"
        defaultValues={
          editingWorkout
            ? {
                title: editingWorkout.title,
                workoutType: editingWorkout.metadata.workoutType as WorkoutType,
                duration: editingWorkout.metadata.duration as number,
                calories: editingWorkout.metadata.calories as number | undefined,
                exercises: (editingWorkout.metadata.exercises as string) || '',
                date: (editingWorkout.metadata.date as string) || '',
                note: (editingWorkout.metadata.note as string) || '',
              }
            : undefined
        }
        onSubmit={handleEditWorkout}
      />
      <SleepMoodDialog
        open={!!editingSleepMood}
        onOpenChange={(open) => !open && setEditingSleepMood(null)}
        title="Edit Sleep & Mood"
        defaultValues={
          editingSleepMood
            ? {
                sleepHours: editingSleepMood.metadata.sleepHours as number | undefined,
                sleepQuality: editingSleepMood.metadata.sleepQuality as SleepQuality | undefined,
                mood: editingSleepMood.metadata.mood as MoodLevel | undefined,
                energy: editingSleepMood.metadata.energy as number | undefined,
                date: (editingSleepMood.metadata.date as string) || '',
                note: (editingSleepMood.metadata.note as string) || '',
              }
            : undefined
        }
        onSubmit={handleEditSleepMood}
      />

      {/* Delete confirm */}
      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title={`Delete ${deleteTarget?.type === 'body-metric' ? 'body metric' : deleteTarget?.type === 'sleep-mood' ? 'sleep & mood entry' : 'workout'}`}
        description={`Are you sure you want to delete "${deleteTarget?.entity.title}"?`}
        onConfirm={handleDelete}
      />
    </div>
  )
}
