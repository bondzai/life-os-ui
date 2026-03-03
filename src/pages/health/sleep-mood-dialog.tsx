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
import { MOOD_OPTIONS, SLEEP_QUALITY, type MoodLevel, type SleepQuality } from './health-helpers'

const schema = z.object({
  sleepHours: z.string().optional(),
  sleepQuality: z.string().optional(),
  mood: z.string().optional(),
  energy: z.string().optional(),
  date: z.string().min(1, 'Date is required'),
  note: z.string().optional(),
})

type FormValues = z.infer<typeof schema>

export interface SleepMoodFormValues {
  sleepHours?: number
  sleepQuality?: SleepQuality
  mood?: MoodLevel
  energy?: number
  date: string
  note?: string
}

interface SleepMoodDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  defaultValues?: Partial<SleepMoodFormValues>
  onSubmit: (values: SleepMoodFormValues) => void
  title?: string
}

export function SleepMoodDialog({
  open,
  onOpenChange,
  defaultValues,
  onSubmit,
  title = 'Log Sleep & Mood',
}: SleepMoodDialogProps) {
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      sleepHours: defaultValues?.sleepHours?.toString() ?? '',
      sleepQuality: defaultValues?.sleepQuality ?? '',
      mood: defaultValues?.mood ?? '',
      energy: defaultValues?.energy?.toString() ?? '',
      date: defaultValues?.date ?? new Date().toISOString().split('T')[0],
      note: defaultValues?.note ?? '',
    },
  })

  useEffect(() => {
    if (defaultValues) {
      form.reset({
        sleepHours: defaultValues.sleepHours?.toString() ?? '',
        sleepQuality: defaultValues.sleepQuality ?? '',
        mood: defaultValues.mood ?? '',
        energy: defaultValues.energy?.toString() ?? '',
        date: defaultValues.date ?? new Date().toISOString().split('T')[0],
        note: defaultValues.note ?? '',
      })
    }
  }, [defaultValues, form])

  const handleSubmit = (values: FormValues) => {
    onSubmit({
      sleepHours: values.sleepHours ? parseFloat(values.sleepHours) : undefined,
      sleepQuality: (values.sleepQuality as SleepQuality) || undefined,
      mood: (values.mood as MoodLevel) || undefined,
      energy: values.energy ? parseInt(values.energy, 10) : undefined,
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
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="sleepHours"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sleep (hours)</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.5" {...field} placeholder="e.g. 7.5" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="sleepQuality"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sleep Quality</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="">None</SelectItem>
                        {SLEEP_QUALITY.map((q) => (
                          <SelectItem key={q} value={q}>
                            {q.charAt(0).toUpperCase() + q.slice(1)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <FormField
                control={form.control}
                name="mood"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Mood</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Select" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="">None</SelectItem>
                        {MOOD_OPTIONS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m.charAt(0).toUpperCase() + m.slice(1)}
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
                name="energy"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Energy (1-10)</FormLabel>
                    <FormControl>
                      <Input type="number" min="1" max="10" {...field} placeholder="1-10" />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>
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
