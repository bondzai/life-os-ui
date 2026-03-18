import { useState, useMemo } from 'react'
import { Settings2, TrendingUp, TrendingDown, Minus, Flame, Timer } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import {
  calcBMI,
  calcBMR,
  calcTDEE,
  calcTDEETargets,
  calcAge,
  calcIdealWeightRange,
  calcWeightTrend,
  calcWeeklyActivity,
  calcProtein,
  suggestGoalMode,
  getBMICategory,
  BMI_COLORS,
  GOAL_MODE_LABELS,
  GOAL_MODE_COLORS,
  ACTIVITY_LABELS,
  loadHealthProfile,
  saveHealthProfile,
  type HealthProfile,
  type Gender,
  type ActivityLevel,
} from '@/lib/health-calc'
import type { Entity } from '@/core/types'

const WHO_TARGET_MINUTES = 150

interface HealthMetricsCardProps {
  bodyMetrics: Entity[]
  workouts: Entity[]
}

export function HealthMetricsCard({ bodyMetrics, workouts }: HealthMetricsCardProps) {
  const [profile, setProfile] = useState<HealthProfile | null>(() => loadHealthProfile())
  const [settingsOpen, setSettingsOpen] = useState(false)

  // Extract weight entries
  const weightEntries = useMemo(() =>
    bodyMetrics
      .filter((m) => m.metadata.metricType === 'weight' && typeof m.metadata.value === 'number')
      .map((m) => ({ value: m.metadata.value as number, date: (m.metadata.date as string) || '' }))
      .sort((a, b) => b.date.localeCompare(a.date)),
    [bodyMetrics],
  )

  const latestWeight = weightEntries[0]?.value ?? null

  // Extract workout data
  const workoutData = useMemo(() =>
    workouts.map((w) => ({
      duration: (w.metadata.duration as number) || 0,
      calories: (w.metadata.calories as number) || 0,
      date: (w.metadata.date as string) || '',
    })),
    [workouts],
  )

  // Latest body fat %
  const latestBodyFat = useMemo(() => {
    const bf = bodyMetrics
      .filter((m) => m.metadata.metricType === 'body-fat' && typeof m.metadata.value === 'number')
      .sort((a, b) => ((b.metadata.date as string) || '').localeCompare((a.metadata.date as string) || ''))
    return bf[0]?.metadata.value as number | undefined
  }, [bodyMetrics])

  // Calculations
  const metrics = useMemo(() => {
    if (!profile || !latestWeight) return null

    const age = calcAge(profile.birthDate)
    const bmi = calcBMI(latestWeight, profile.heightCm)
    const bmiCategory = getBMICategory(bmi)
    const bmr = calcBMR(latestWeight, profile.heightCm, age, profile.gender)
    const tdee = calcTDEE(bmr, profile.activityLevel)
    const targets = calcTDEETargets(tdee)
    const idealRange = calcIdealWeightRange(profile.heightCm)
    const weightTrend = calcWeightTrend(weightEntries)
    const weekly = calcWeeklyActivity(workoutData)
    const suggestion = suggestGoalMode(bmi, bmiCategory, latestBodyFat)
    const protein = calcProtein(latestWeight, suggestion.mode)

    return { age, bmi, bmiCategory, bmr, tdee, targets, idealRange, weightTrend, weekly, suggestion, protein }
  }, [profile, latestWeight, latestBodyFat, weightEntries, workoutData])

  // No profile yet — show setup prompt
  if (!profile) {
    return (
      <>
        <Card className="border-dashed">
          <CardContent className="flex items-center justify-between py-4">
            <div>
              <p className="text-sm font-medium">Set up health profile</p>
              <p className="text-xs text-muted-foreground">Add height, age, and gender to see BMI, BMR, TDEE calculations</p>
            </div>
            <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
              <Settings2 className="h-3.5 w-3.5 mr-1.5" /> Set Up
            </Button>
          </CardContent>
        </Card>
        <ProfileDialog open={settingsOpen} onOpenChange={setSettingsOpen} profile={profile} onSave={(p) => { setProfile(p); saveHealthProfile(p) }} />
      </>
    )
  }

  // No weight data yet
  if (!metrics) {
    return (
      <Card className="border-dashed">
        <CardContent className="py-4">
          <p className="text-sm text-muted-foreground">Log your weight in Body Metrics to see health calculations.</p>
        </CardContent>
      </Card>
    )
  }

  const { bmi, bmiCategory, bmr, tdee, targets, idealRange, weightTrend, weekly, suggestion, protein } = metrics
  const activeMinPct = Math.min(100, Math.round((weekly.activeMinutes / WHO_TARGET_MINUTES) * 100))

  const TrendIcon = weightTrend?.direction === 'up' ? TrendingUp : weightTrend?.direction === 'down' ? TrendingDown : Minus

  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {/* BMI */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground">BMI</CardTitle>
            <Badge className={`text-[10px] px-1.5 py-0 capitalize ${BMI_COLORS[bmiCategory]}`} variant="secondary">
              {bmiCategory}
            </Badge>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{bmi.toFixed(1)}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              Ideal: {idealRange.min}–{idealRange.max} kg
            </p>
          </CardContent>
        </Card>

        {/* BMR */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground">BMR</CardTitle>
            <Flame className="h-3.5 w-3.5 text-orange-500" />
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{Math.round(bmr)}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">kcal/day at rest</p>
          </CardContent>
        </Card>

        {/* TDEE with bulk/cut */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground">TDEE</CardTitle>
            <Badge className={`text-[10px] px-1.5 py-0 ${GOAL_MODE_COLORS[suggestion.mode]}`} variant="secondary">
              {GOAL_MODE_LABELS[suggestion.mode]}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-1.5">
            <p className="text-2xl font-bold">{Math.round(tdee)}</p>
            <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
              <span className="text-red-500">Cut: {targets.cut}</span>
              <span className="text-green-500">Lean bulk: {targets.leanBulk}</span>
              <span className="text-blue-500">Maintain: {targets.maintain}</span>
              <span className="text-purple-500">Bulk: {targets.bulk}</span>
            </div>
          </CardContent>
        </Card>

        {/* Weight Trend */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground">Weight Trend</CardTitle>
            {weightTrend && <TrendIcon className={`h-3.5 w-3.5 ${weightTrend.direction === 'up' ? 'text-red-500' : weightTrend.direction === 'down' ? 'text-green-500' : 'text-muted-foreground'}`} />}
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{weightTrend ? `${weightTrend.avg} kg` : '—'}</p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {weightTrend ? `${weightTrend.change > 0 ? '+' : ''}${weightTrend.change} kg (7d avg)` : 'Need more data'}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Suggested Mode Card */}
      <Card className={`border-l-4 ${
        suggestion.mode === 'cut' ? 'border-l-red-500' :
        suggestion.mode === 'maintain' ? 'border-l-blue-500' :
        suggestion.mode === 'lean-bulk' ? 'border-l-green-500' :
        'border-l-purple-500'
      }`}>
        <CardContent className="py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium">
                  Suggested: {GOAL_MODE_LABELS[suggestion.mode]}
                </span>
                <Badge className={`text-[10px] px-1.5 py-0 ${GOAL_MODE_COLORS[suggestion.mode]}`} variant="secondary">
                  {suggestion.mode === 'cut' ? `${targets.cut} kcal/day` :
                   suggestion.mode === 'maintain' ? `${targets.maintain} kcal/day` :
                   suggestion.mode === 'lean-bulk' ? `${targets.leanBulk} kcal/day` :
                   `${targets.bulk} kcal/day`}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">{suggestion.reason}</p>
            </div>
            <div className="text-right shrink-0">
              <p className="text-lg font-bold">{protein}g</p>
              <p className="text-[10px] text-muted-foreground">protein/day</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Weekly Activity Bar */}
      <Card>
        <CardContent className="py-3">
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-2">
              <Timer className="h-4 w-4 text-muted-foreground" />
              <span className="text-sm font-medium">Weekly Active Minutes</span>
            </div>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span>{weekly.activeMinutes} / {WHO_TARGET_MINUTES} min</span>
              {weekly.caloriesBurned > 0 && <span>{weekly.caloriesBurned.toLocaleString()} kcal burned</span>}
              <Button variant="ghost" size="sm" className="h-6 w-6 p-0" onClick={() => setSettingsOpen(true)}>
                <Settings2 className="h-3 w-3" />
              </Button>
            </div>
          </div>
          <Progress value={activeMinPct} className="h-2" />
        </CardContent>
      </Card>

      <ProfileDialog open={settingsOpen} onOpenChange={setSettingsOpen} profile={profile} onSave={(p) => { setProfile(p); saveHealthProfile(p) }} />
    </>
  )
}

// ---------------------------------------------------------------------------
// Profile Settings Dialog
// ---------------------------------------------------------------------------

function ProfileDialog({
  open,
  onOpenChange,
  profile,
  onSave,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  profile: HealthProfile | null
  onSave: (profile: HealthProfile) => void
}) {
  const [heightCm, setHeightCm] = useState(profile?.heightCm?.toString() || '')
  const [birthDate, setBirthDate] = useState(profile?.birthDate || '')
  const [gender, setGender] = useState<Gender>(profile?.gender || 'male')
  const [activityLevel, setActivityLevel] = useState<ActivityLevel>(profile?.activityLevel || 'moderate')

  const canSave = heightCm && parseFloat(heightCm) > 0 && birthDate

  const handleSave = () => {
    if (!canSave) return
    onSave({
      heightCm: parseFloat(heightCm),
      birthDate,
      gender,
      activityLevel,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Health Profile</DialogTitle>
          <DialogDescription>Used to calculate BMI, BMR, and TDEE.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="hp-height">Height (cm)</Label>
            <Input id="hp-height" type="number" placeholder="170" value={heightCm} onChange={(e) => setHeightCm(e.target.value)} min={100} max={250} />
          </div>
          <div>
            <Label htmlFor="hp-birthdate">Date of Birth</Label>
            <Input id="hp-birthdate" type="date" value={birthDate} onChange={(e) => setBirthDate(e.target.value)} />
          </div>
          <div>
            <Label>Gender</Label>
            <Select value={gender} onValueChange={(v) => setGender(v as Gender)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="male">Male</SelectItem>
                <SelectItem value="female">Female</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>Activity Level</Label>
            <Select value={activityLevel} onValueChange={(v) => setActivityLevel(v as ActivityLevel)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.entries(ACTIVITY_LABELS) as [ActivityLevel, string][]).map(([key, label]) => (
                  <SelectItem key={key} value={key}>{label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
            <Button size="sm" onClick={handleSave} disabled={!canSave}>Save</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
