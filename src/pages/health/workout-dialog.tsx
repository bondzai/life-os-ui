import { useEffect } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form'
import { WORKOUT_TYPES, type WorkoutType } from './health-helpers'

const schema = z.object({
  title: z.string().min(1, 'Title is required'),
  workoutType: z.enum(['strength', 'cardio', 'flexibility', 'hiit', 'sports', 'other']),
  duration: z.string().min(1, 'Duration is required'),
  calories: z.string().optional(),
  exercises: z.string().optional(),
  date: z.string().min(1, 'Date is required'),
  note: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export interface WorkoutFormValues {
  title: string
  workoutType: WorkoutType
  duration: number
  calories?: number
  exercises?: string
  date: string
  note?: string
}

interface WorkoutDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultValues?: Partial<WorkoutFormValues>
  onSubmit: (values: WorkoutFormValues) => void
  title?: string
}

export function WorkoutDialog({
  open,
  onOpenChange,
  defaultValues,
  onSubmit,
  title = 'Log Workout',
}: WorkoutDialogProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      title: defaultValues?.title ?? '',
      workoutType: defaultValues?.workoutType ?? 'strength',
      duration: defaultValues?.duration?.toString() ?? '',
      calories: defaultValues?.calories?.toString() ?? '',
      exercises: defaultValues?.exercises ?? '',
      date: defaultValues?.date ?? new Date().toISOString().split('T')[0],
      note: defaultValues?.note ?? '',
    },
  })

  useEffect(() => {
    if (defaultValues) {
      form.reset({
        title: defaultValues.title ?? '',
        workoutType: defaultValues.workoutType ?? 'strength',
        duration: defaultValues.duration?.toString() ?? '',
        calories: defaultValues.calories?.toString() ?? '',
        exercises: defaultValues.exercises ?? '',
        date: defaultValues.date ?? new Date().toISOString().split('T')[0],
        note: defaultValues.note ?? '',
      })
    }
  }, [defaultValues, form])

  const handleSubmit = (values: FormValues) => {
    onSubmit({
      title: values.title,
      workoutType: values.workoutType,
      duration: parseInt(values.duration, 10),
      calories: values.calories ? parseInt(values.calories, 10) : undefined,
      exercises: values.exercises || undefined,
      date: values.date,
      note: values.note || undefined,
    })
    form.reset()
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="workoutType"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Type</FormLabel>
                  <Select onValueChange={field.onChange} defaultValue={field.value}>
                    <FormControl>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                    </FormControl>
                    <SelectContent>
                      {WORKOUT_TYPES.map((t) => (
                        <SelectItem key={t} value={t}>
                          {t === 'hiit' ? 'HIIT' : t.charAt(0).toUpperCase() + t.slice(1)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="title"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Title</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="e.g. Morning run, Upper body" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="duration"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Duration (min)</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="calories"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Calories (est.)</FormLabel>
                    <FormControl>
                      <Input type="number" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <FormField
              control={form.control}
              name="exercises"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Exercises</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="e.g. Bench 3x10, Squats 4x8" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Date</FormLabel>
                  <FormControl>
                    <Input type="date" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="note"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Note</FormLabel>
                  <FormControl>
                    <Input {...field} placeholder="Optional note" />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit">Save</Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  )
}
